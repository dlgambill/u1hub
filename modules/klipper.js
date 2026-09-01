// modules/klipper.js — each printer's own Klipper UI, reachable wherever the
// Hub is reachable (v2.21).
//
// The problem, in Danny's words: "if I'm outside of the network I can't access
// the printers Klipper pages." The Hub already publishes itself through a
// Cloudflare tunnel, but the tunnel points at ONE origin — the Hub's port. The
// nine printers are separate hosts on the LAN and the tunnel knows nothing
// about them, so every ↗ link on the Dash was a dead link from anywhere but the
// house.
//
// WHY A HUB PROXY, and not nine Cloudflare ingress rules
// Nine public hostnames pointed straight at the printers needs no Hub code at
// all — and publishes nine unauthenticated printer-control UIs, because Klipper
// has no login of its own. Anyone who found one could home the toolhead, heat a
// nozzle, or start a print. Behind the Hub, they inherit the password gate that
// already fronts everything else, and the tunnel's own interlock (tunnel.js
// refuses to start unless auth is in password mode) covers them for free. One
// login, nine printers, nothing new exposed.
//
// WHY IT WORKS WITHOUT REBUILDING FLUIDD
// Measured against a real U1 on 2026-09-01 before a line was written:
//   * index.html references every asset RELATIVELY (./assets/…, ./img/…) —
//     zero absolute src/href — so the app loads unchanged under a path prefix.
//   * Fluidd reads /config.json at boot and takes its Moonraker endpoint from
//     `endpoints`. Its parser keeps the URL's PATHNAME and appends "websocket"
//     to it. Give it "https://host/p/3" and it asks for https://host/p/3/server/…
//     and wss://host/p/3/websocket. Path prefixes are a supported shape, not a
//     hack we are getting away with.
// So the only rewriting this module does is that one JSON file. Everything
// else — HTML, JS, thumbnails, gcode uploads, the socket — is relayed byte for
// byte. Nothing parses or edits a response body.
//
// WHAT IS DELIBERATELY NOT DONE
// No caching, no retries, no response rewriting. A proxy that gets clever about
// a payload it does not own is a proxy that breaks on the printer's next
// firmware update. If Moonraker returns 500, so do we, with its own body.

"use strict";

const http = require("http");
const { URL } = require("url");

// Hop-by-hop headers (RFC 7230 §6.1). These describe THIS connection, not the
// message, and forwarding them corrupts the next hop — a relayed
// "Transfer-Encoding: chunked" against a re-framed body is the classic way to
// desync a proxy.
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function stripHop(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) if (!HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

// The public origin THIS request arrived on, which is what Fluidd must be told
// to call back on. Behind the tunnel that is the Cloudflare hostname over
// https; on the LAN it is the Hub's own host over http. Reading it from the
// request rather than from config means it is right in both places at once and
// survives the hostname changing, which a quick tunnel's does every restart.
function originOf(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? proto + "://" + host : "";
}

function targetOf(printer) {
  if (!printer || !printer.url) return null;
  let u;
  try { u = new URL(printer.url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return { host: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), protocol: u.protocol };
}

function register(ctx) {
  const { app, hublog } = ctx;
  const PREFIX = ctx.proxyPrefix || "/p/";

  const printerAt = id => {
    const list = ctx.printers || [];
    const i = Number(id);
    return Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : null;
  };

  // Split "/p/3/server/files/list?root=gcodes" into { id:3, rest:"/server/files/list?root=gcodes" }.
  // Anchored, digits only: "/p/../.." can never name anything but a printer index.
  function routeOf(url) {
    const m = new RegExp("^" + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)(/.*)?$").exec(url || "");
    if (!m) return null;
    return { id: Number(m[1]), rest: m[2] || "/" };
  }

  // ---- GET /api/klipper — what the client needs to build links ----
  app.get("/api/klipper", (req, res) => {
    res.json({
      prefix: PREFIX,
      printers: (ctx.printers || []).map((p, i) => ({
        id: i, name: p.name,
        direct: p.url || "",
        path: p.url ? PREFIX + i + "/" : ""
      }))
    });
  });

  // ---- the proxy ----
  app.use(PREFIX, (req, res) => {
    // req.url here is already relative to PREFIX ("/3/server/info"), so put the
    // prefix back before routing rather than parsing two shapes.
    const r = routeOf(PREFIX + String(req.url).replace(/^\//, ""));
    if (!r) return res.status(404).json({ error: "Not a printer path" });
    const printer = printerAt(r.id);
    const tgt = targetOf(printer);
    if (!tgt) return res.status(404).json({ error: "No printer " + r.id });

    const pathOnly = r.rest.split("?")[0];

    // A WebSocket handshake landing HERE means the upgrade was downgraded to a
    // plain request somewhere upstream (a proxy that strips Upgrade headers) —
    // the printer would answer 400 and the browser would show a dead socket
    // with no clue anywhere. Name the real problem in the log.
    if (/upgrade/i.test(String(req.headers.connection || "")) || req.headers.upgrade)
      hublog("warn", "klipper: " + r.rest + " arrived as a plain request carrying Upgrade headers — " +
        "something between the browser and the Hub is not passing WebSocket upgrades through");

    // The ONE rewritten response. Everything else is relayed untouched.
    if (pathOnly === "/config.json") return serveConfig(req, res, r.id, tgt);

    // A bare "/p/3" (no trailing slash) must redirect, not serve: the browser
    // would resolve Fluidd's "./assets/…" against "/p/" and every asset would
    // 404 one directory too high. This is the single most common way a
    // path-prefixed SPA proxy appears broken.
    if (r.rest === "/" && !/\/$/.test(req.originalUrl.split("?")[0]))
      return res.redirect(302, PREFIX + r.id + "/");

    const headers = stripHop(req.headers);
    // The printer must see its own name, or Moonraker's CORS check refuses a
    // host it has never heard of.
    headers.host = tgt.host + (String(tgt.port) === "80" ? "" : ":" + tgt.port);
    delete headers["accept-encoding"];   // relay identity bytes; nothing here re-frames a gzip stream
    // Our session cookie is for the Hub and means nothing to Moonraker. Sending
    // it leaks the Hub's session to a device on the LAN for no benefit.
    delete headers.cookie;

    const preq = http.request({
      host: tgt.host, port: tgt.port, method: req.method, path: r.rest,
      headers, agent: false, timeout: 30000
    }, pres => {
      try {
        pres.on("error", () => { try { res.destroy(); } catch {} });
        res.writeHead(pres.statusCode || 502, stripHop(pres.headers));
        pres.pipe(res);
      } catch { try { res.destroy(); } catch {} try { pres.destroy(); } catch {} }
    });
    preq.on("timeout", () => { preq.destroy(new Error("printer did not answer in 30 s")); });
    preq.on("error", e => {
      try {
        if (res.headersSent) return res.destroy();
        res.status(502).json({ error: (printer.name || "Printer " + r.id) + " is not answering: " + e.message });
      } catch {}
    });
    // A client that walks away mid-transfer (phones do, constantly) must tear
    // down the printer leg quietly — an unhandled 'error' on either stream is
    // process-fatal, and this path carries every camera snapshot and upload.
    req.on("error", () => { try { preq.destroy(); } catch {} });
    res.on("error", () => { try { preq.destroy(); } catch {} });
    res.on("close", () => { if (!res.writableEnded) { try { preq.destroy(); } catch {} } });
    // The body is still an unread stream: core skips express.json() for this
    // prefix precisely so uploads and JSON alike arrive here intact.
    req.pipe(preq);
  });

  // Fluidd's own /config.json with `endpoints` pointed back through this proxy.
  // Fetched from the printer rather than invented, so themes, the blacklist and
  // anything a future Fluidd adds keep working; only `endpoints` is replaced.
  function serveConfig(req, res, id, tgt) {
    const base = originOf(req) + PREFIX + id;
    const fallback = { endpoints: [base], instancesDB: "local" };
    const preq = http.request({
      host: tgt.host, port: tgt.port, method: "GET", path: "/config.json",
      headers: { host: tgt.host, accept: "application/json" }, agent: false, timeout: 10000
    }, pres => {
      const chunks = [];
      pres.on("data", c => chunks.push(c));
      pres.on("end", () => {
        let cfg = fallback;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (parsed && typeof parsed === "object") cfg = { ...parsed, endpoints: [base] };
        } catch { /* keep the fallback — an unparseable config is not a reason to fail */ }
        res.set("cache-control", "no-store").json(cfg);
      });
    });
    preq.on("timeout", () => preq.destroy(new Error("timeout")));
    preq.on("error", () => res.set("cache-control", "no-store").json(fallback));
    preq.end();
  }

  // ---- the WebSocket ----
  // Moonraker's live state (temps, progress, the console) rides on
  // ws://<printer>/websocket. Without this the Fluidd page loads, renders, and
  // then sits there permanently "connecting" — which reads as a broken printer
  // rather than a missing proxy, so this is not an optional half of the job.
  ctx.onUpgrade((req, socket, head) => {
    const r = routeOf(String(req.url || "").split("?")[0]);
    if (!r) return false;                       // not ours; let another handler try
    // The Express gate never runs on an upgrade. Ask the same question here, or
    // the socket is a hole straight through the password to printer control.
    if (!ctx.isAuthed(req)) {
      // Logged, unlike most 401s: a session that works for the page but not
      // the socket is a config bug (cookie flags, proxy stripping), and from
      // the browser both failures look like the same dead "connecting…".
      // Diagnostic detail: cookie NAMES only, never values. "cookie absent" vs
      // "cookie present but not accepted" are two different bugs.
      const names = String(req.headers.cookie || "").split(";").map(s => s.trim().split("=")[0]).filter(Boolean);
      hublog("warn", "klipper: websocket upgrade refused — no valid session (path " + req.url +
        ", cookies " + (names.length ? names.join(",") : "ABSENT") + ")");
      try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); } catch {}
      socket.destroy();
      return true;
    }
    const printer = printerAt(r.id);
    const tgt = targetOf(printer);
    if (!tgt) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return true; }

    const qs = String(req.url).includes("?") ? "?" + String(req.url).split("?").slice(1).join("?") : "";
    const headers = stripHop(req.headers);
    headers.host = tgt.host + (String(tgt.port) === "80" ? "" : ":" + tgt.port);
    delete headers.cookie;
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";

    // EVERY write in the callbacks below is guarded. These fire asynchronously
    // — after the client may have walked away — and an unguarded write to a
    // dead socket is an uncaughtException, which in Node is not a failed
    // request: it is the END OF THE PROCESS. Production learned this on
    // 2026-09-01: the first phone through the tunnel took the entire Hub down,
    // nine printers' scheduler with it, and cloudflared kept serving 502s over
    // the corpse. A dropped socket is Tuesday; it must never be lethal.
    const dead = s => !s || s.destroyed || s.writableEnded;
    const safeWrite = (s, data) => { try { if (!dead(s)) s.write(data); } catch {} };
    const safeEnd = s => { try { if (s) s.destroy(); } catch {} };

    const preq = http.request({
      host: tgt.host, port: tgt.port, method: req.method || "GET",
      path: r.rest + qs, headers, agent: false
    });
    preq.on("upgrade", (pres, psocket, phead) => {
      try {
        psocket.on("error", () => safeEnd(socket));
        socket.on("error", () => safeEnd(psocket));
        if (dead(socket)) { safeEnd(psocket); return; }   // client left during the dial
        // Rebuild the 101 verbatim. The Sec-WebSocket-Accept value is a hash of
        // the client's key — regenerating it would be wrong, and the browser
        // checks it.
        const lines = ["HTTP/1.1 101 Switching Protocols"];
        for (const [k, v] of Object.entries(pres.headers))
          for (const one of [].concat(v)) lines.push(k + ": " + one);
        safeWrite(socket, lines.join("\r\n") + "\r\n\r\n");
        if (phead && phead.length) safeWrite(socket, phead);
        if (head && head.length) safeWrite(psocket, head);
        psocket.pipe(socket).pipe(psocket);
      } catch (e) {
        hublog("warn", "klipper: websocket splice to " + (printer.name || r.id) + " failed: " + e.message);
        safeEnd(psocket); safeEnd(socket);
      }
    });
    preq.on("response", pres => {   // printer answered without upgrading
      safeWrite(socket, "HTTP/1.1 " + (pres.statusCode || 502) + "\r\nConnection: close\r\n\r\n");
      safeEnd(socket);
    });
    preq.on("error", e => {
      hublog("warn", "klipper: websocket to " + (printer.name || r.id) + " failed: " + e.message);
      safeWrite(socket, "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      safeEnd(socket);
    });
    preq.end();
    return true;
  });

  hublog("info", "klipper: printer UIs proxied at " + PREFIX + "<id>/");
}

module.exports = { register, stripHop, originOf, targetOf, HOP };
