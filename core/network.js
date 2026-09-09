// core/network.js — network inventory, diagnostics bundle, subnet discovery, debug websocket
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");

module.exports = function (hub) {
const { BASE_DIR, HUBLOG, IS_PKG, VERSION, app, detectCaps, fmem } = hub;


// ---- Smart power control: extracted to modules/power.js (v2.11) ------------

// ---- Network inventory: name / IP / MAC / serial, for DHCP reservations ----
function pickIface(net) {
  let fallback = null;
  for (const name in net) {
    const ifc = net[name] || {};
    const v4 = (ifc.ip_addresses || []).find(a => a.family === "ipv4" && !a.is_link_local);
    if (v4) return { iface: name, mac: ifc.mac_address || null, ip: v4.address };
    if (!fallback && ifc.mac_address) fallback = { iface: name, mac: ifc.mac_address, ip: null };
  }
  return fallback || { iface: null, mac: null, ip: null };
}


async function probeInfo(p) {
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/machine/system_info", { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { name: p.name, online: false, error: "HTTP " + r.status };
    const si = (await r.json()).result.system_info || {};
    const pi = si.product_info || {};
    const { iface, mac, ip } = pickIface(si.network || {});
    return {
      name: p.name, online: true,
      device_name: pi.device_name || null,
      machine_type: pi.machine_type || null,
      serial: pi.serial_number || null,
      iface, mac, ip
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}


app.get("/api/inventory", async (req, res) => {
  const out = await Promise.all(hub.PRINTERS.map((p, i) => probeInfo(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});


// ---- Diagnostics bundle (v2.9, beta support) --------------------------------
// User-initiated ONLY — the Hub has zero telemetry and this keeps it that way.
// Settings → "Download diagnostics" produces one JSON the user reviews and
// attaches to a GitHub issue. Contents: version/platform, types + warnings,
// printers with DETECTED capabilities, the in-memory ring buffer, and the tail
// of each printer's klippy.log + moonraker.log fetched over Moonraker's file
// API with a suffix Range header (~192 KB per log — klippy.log can be tens of
// MB and we only ever want the recent end).
//
// Rule #1 note: HTTP 206 ranged GETs are hardware-verified on the Snapmaker
// fork for GCODE paths; /server/files/klippy.log on the fork is UNVERIFIED, so
// every log fetch is individually tolerant — a missing log becomes a note in
// the bundle, never a failed export. Stock Moonraker serves both logs there.
//
// Sanitization happens at generation, before the user ever sees the file:
//   * every configured printer host → stable alias ("printer-1", …) so reports
//     stay legible without leaking the LAN layout
//   * any remaining IPv4 (incl. loopback) → "x.x.x.x"
//   * JWT-shaped tokens (tunnel credentials pasted into logs) → "<token>"
//   * auth.json / tunnel.json contents are never read — only booleans ship
const DIAG_TAIL_BYTES = 192 * 1024;

async function diagFetchLogTail(base, file) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(base + "/server/files/" + file, {
      headers: { Range: "bytes=-" + DIAG_TAIL_BYTES }, signal: ctrl.signal
    });
    clearTimeout(to);
    if (r.status !== 200 && r.status !== 206)
      return { ok: false, note: "HTTP " + r.status + " — log not exposed at /server/files/" + file };
    // A server that ignores Range replies 200 with the WHOLE file. Refuse to
    // inline anything huge rather than ballooning the bundle (or Hub memory).
    const len = parseInt(r.headers.get("content-length") || "0", 10);
    if (r.status === 200 && len > 2 * 1024 * 1024)
      return { ok: false, note: "server ignored Range and the full log is " + (len / 1048576).toFixed(1) + " MB — too large to inline" };
    let text = await r.text();
    if (text.length > DIAG_TAIL_BYTES) text = text.slice(-DIAG_TAIL_BYTES);
    return { ok: true, ranged: r.status === 206, bytes: text.length, tail: text };
  } catch (e) {
    return { ok: false, note: String((e && e.message) || e) };
  }
}

app.get("/api/diagnostics", async (req, res) => {
  const withLogs = String(req.query.logs || "1") !== "0";
  const onlyIdx = req.query.printer !== undefined ? parseInt(req.query.printer, 10) : null;

  const printers = await Promise.all(hub.PRINTERS.map(async (p, i) => ({
    alias: "printer-" + (i + 1),
    name: p.name, type: p.type || "u1",
    caps: (await detectCaps(i)) || null,
    plug: (hub.FEATURES.power && p.plug && p.plug.type) || null
  })));

  let spoolsBound = 0, slotsAssigned = 0;
  try { const s = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "spools.json"), "utf8")); spoolsBound = Object.keys(s.spools || {}).length; } catch {}
  try {
    const sl = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "slots.json"), "utf8"));
    for (const m of Object.values(sl || {})) slotsAssigned += Object.keys(m || {}).length;
  } catch {}

  const bundle = {
    generatedAt: new Date().toISOString(),
    hub: { version: VERSION, node: process.version, platform: process.platform, arch: process.arch, pkg: IS_PKG, uptimeSec: Math.round(process.uptime()) },
    auth: { enabled: fs.existsSync(path.join(BASE_DIR, "auth.json")) },       // boolean only — contents never read
    tunnel: { configured: fs.existsSync(path.join(BASE_DIR, "tunnel.json")) }, // boolean only — contents never read
    types: hub.TYPES.map(t => ({ slug: t.slug, label: t.label, builtin: !!t.builtin, beta: !t.builtin, warning: hub.TYPE_WARNINGS[t.slug] || null, printerCount: hub.PRINTERS.filter(p => (p.type || "u1") === t.slug).length })),
    printers,
    counts: { queue: hub.QUEUE.length, spoolsBound, slotsAssigned, filamentMemories: Object.keys(fmem()).length },
    log: HUBLOG.slice(),
    klipperLogs: {}
  };

  if (withLogs) {
    for (let i = 0; i < hub.PRINTERS.length; i++) {
      if (onlyIdx !== null && i !== onlyIdx) continue;
      const base = String(hub.PRINTERS[i].url).replace(/\/+$/, "");
      bundle.klipperLogs["printer-" + (i + 1)] = {
        klippy: await diagFetchLogTail(base, "klippy.log"),
        moonraker: await diagFetchLogTail(base, "moonraker.log")
      };
    }
  }

  // Sanitize the SERIALIZED bundle so nothing slips through a nested field.
  let out = JSON.stringify(bundle, null, 2);
  hub.PRINTERS.forEach((p, i) => {
    try {
      const host = new URL(p.url).hostname;
      if (host) out = out.split(host).join("printer-" + (i + 1));
    } catch {}
  });
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "x.x.x.x");
  out = out.replace(/eyJ[A-Za-z0-9._\-]{20,}/g, "<token>");
  res.type("json").send(out);
});


// Normalize a printer url to host:port for identity comparison. Two config
// entries with the same origin are the same physical printer twice — the
// end-user error class behind a long stale-claim diagnosis in the 2.11 cycle
// (two printers "sharing" one IP). Same IP on DIFFERENT ports stays legal:
// a multi-instance Klipper host (one Pi, several Moonrakers on :7125/:7126)
// is a real setup this guard must not break.
function printerOrigin(u) {
  try {
    const x = new URL(String(u));
    return (x.hostname + ":" + (x.port || (x.protocol === "https:" ? "443" : "80"))).toLowerCase();
  } catch { return String(u || "").toLowerCase().replace(/\/+$/, ""); }
}


// ---- Auto-discovery: scan the local subnet(s) for Moonraker printers ----
function localSubnets() {
  const out = new Set();
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name] || []) {
    if (a.family === "IPv4" && !a.internal) out.add(a.address.split(".").slice(0, 3).join("."));
  }
  return [...out];
}

// Probe both known Moonraker ports: the U1 serves on :80 (Snapmaker quirk);
// stock Moonraker (e.g. Sovol SV06 Plus ACE) serves on :7125. The port rides
// in the printer's url, so every downstream call is per-instance automatically.
async function probeMoonraker(ip) {
  for (const port of [80, 7125]) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 900);
      const base = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
      const r = await fetch(base + "/machine/system_info", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const si = ((await r.json()).result || {}).system_info;
      if (!si) continue;
      const pi = si.product_info || {};
      const { mac } = pickIface(si.network || {});
      return { ip, url: base, device_name: pi.device_name || null, machine_type: pi.machine_type || null, serial: pi.serial_number || null, mac };
    } catch { /* try next port */ }
  }
  return null;
}

app.get("/api/discover", async (req, res) => {
  const found = [];
  for (const base of localSubnets()) {
    const ips = [];
    for (let i = 1; i <= 254; i++) ips.push(base + "." + i);
    const B = 40;
    for (let i = 0; i < ips.length; i += B) {
      const results = await Promise.all(ips.slice(i, i + B).map(probeMoonraker));
      results.forEach(r => { if (r) found.push(r); });
    }
  }
  // Duplicate-IP awareness (v2.12): flag found devices that are already a
  // configured printer, by origin rather than exact URL string, so a
  // trailing-slash or case difference can't invite a second entry for the
  // same machine.
  const cfgByOrigin = new Map((hub.PRINTERS || []).map(p => [printerOrigin(p.url), p.name]));
  for (const f of found) {
    const n = cfgByOrigin.get(printerOrigin(f.url));
    if (n) f.configured = n;
  }
  res.json({ subnets: localSubnets(), found });
});


// ---- DEBUG: hidden websocket listener (curl-driven, no UI) --------------
// Purpose: observe every JSON-RPC notification Moonraker broadcasts so we can
// diff "before vs after" a touchscreen action (e.g. a filament color change)
// and learn whether that action crosses Moonraker at all.
//
// Uses Node's BUILT-IN browser-style WebSocket client (stable since 22.4).
// pkg builds target node22-*, so this works identically in the packaged exe —
// zero new dependencies. Note this is the browser API (onopen/onmessage/send),
// NOT the `ws` npm package API.
//
// Usage:
//   GET /api/debug/ws/start?id=0          open socket, list objects, subscribe to ALL
//   GET /api/debug/ws/dump?id=0           read the ring buffer
//   GET /api/debug/ws/dump?id=0&since=MS  only entries at/after epoch-ms (for diffing)
//   GET /api/debug/ws/stop?id=0           close socket, free the buffer
//
// notify_proc_stat_update fires ~1/sec and would drown the buffer, so those
// are counted but not stored (procStatSkipped in dump output).

const WSDBG = new Map();          // printer idx -> session

const WSDBG_MAX = 500;            // ring buffer cap per printer


function wsdbgPush(s, entry) {
  s.buf.push(entry);
  if (s.buf.length > WSDBG_MAX) s.buf.splice(0, s.buf.length - WSDBG_MAX);
}


app.get("/api/debug/ws/start", (req, res) => {
  const idx = +req.query.id;
  const p = hub.PRINTERS[idx];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (typeof WebSocket === "undefined")
    return res.status(500).json({ error: "Built-in WebSocket client unavailable (needs Node 22.4+)" });

  const old = WSDBG.get(idx);
  if (old && old.ws && old.ws.readyState <= 1) // CONNECTING or OPEN
    return res.json({ ok: true, already: true, status: old.status, buffered: old.buf.length });

  const wsUrl = String(p.url).replace(/\/+$/, "").replace(/^http/, "ws") + "/websocket";
  const s = { ws: null, buf: [], nextId: 1000, status: "connecting", startedAt: Date.now(), procStatSkipped: 0, listId: null };
  WSDBG.set(idx, s);

  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (e) { s.status = "error: " + e.message; return res.status(502).json({ error: e.message }); }
  s.ws = ws;

  const send = (method, params) => {
    const id = s.nextId++;
    const msg = { jsonrpc: "2.0", method, params: params || {}, id };
    try { ws.send(JSON.stringify(msg)); wsdbgPush(s, { t: Date.now(), dir: "out", data: msg }); } catch {}
    return id;
  };

  ws.onopen = () => {
    s.status = "open";
    wsdbgPush(s, { t: Date.now(), dir: "info", data: "connected " + wsUrl });
    s.listId = send("printer.objects.list");
  };

  ws.onmessage = (ev) => {
    let j; try { j = JSON.parse(ev.data); } catch { j = { raw: String(ev.data).slice(0, 500) }; }
    if (j.method === "notify_proc_stat_update") { s.procStatSkipped++; return; } // ~1/sec noise
    wsdbgPush(s, { t: Date.now(), dir: "in", data: j });
    // Object list arrived → subscribe to EVERYTHING on it (null = all fields).
    if (s.listId !== null && j.id === s.listId && j.result && Array.isArray(j.result.objects)) {
      const objects = {};
      for (const name of j.result.objects) objects[name] = null;
      send("printer.objects.subscribe", { objects });
    }
  };

  ws.onerror = () => { s.status = "error"; wsdbgPush(s, { t: Date.now(), dir: "info", data: "socket error" }); };
  ws.onclose = (ev) => {
    if (s.status !== "error") s.status = "closed";
    wsdbgPush(s, { t: Date.now(), dir: "info", data: "closed code=" + (ev && ev.code) });
  };

  res.json({ ok: true, target: wsUrl, dump: "/api/debug/ws/dump?id=" + idx, note: "add &since=<epoch ms> to dump for diffing" });
});


app.get("/api/debug/ws/dump", (req, res) => {
  const idx = +req.query.id;
  const s = WSDBG.get(idx);
  if (!s) return res.status(404).json({ error: "No listener for that printer — hit /api/debug/ws/start?id=" + (isNaN(idx) ? "N" : idx) + " first" });
  const since = +req.query.since || 0;
  const entries = s.buf.filter(e => e.t >= since);
  res.json({
    status: s.status,
    startedAt: s.startedAt,
    now: Date.now(),                 // pass this back as &since= on the next dump
    procStatSkipped: s.procStatSkipped,
    total: s.buf.length,
    returned: entries.length,
    entries
  });
});


app.get("/api/debug/ws/stop", (req, res) => {
  const idx = +req.query.id;
  const s = WSDBG.get(idx);
  if (!s) return res.status(404).json({ error: "No listener for that printer" });
  try { if (s.ws) s.ws.close(); } catch {}
  WSDBG.delete(idx);
  res.json({ ok: true, buffered: s.buf.length, procStatSkipped: s.procStatSkipped });
});

Object.assign(hub, { printerOrigin });
};
