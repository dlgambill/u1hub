// Live gate for the v2.21 Klipper proxy, against the throwaway Hub on 4546 and
// a REAL printer. Checks the four things that decide whether the feature works:
//   1. /p/<id>/ serves Fluidd's index (relative assets intact)
//   2. an asset under the prefix comes back byte-identical to the printer's own
//   3. /p/<id>/config.json points Fluidd back through the proxy
//   4. the WebSocket upgrade completes and Moonraker answers on it
const http = require("http");
const crypto = require("crypto");

const HUB = { host: "127.0.0.1", port: 4546 };
const ID = Number(process.argv[2] || 0);
let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra).slice(0, 300))); }
};
function get(opts, path) {
  return new Promise(res => {
    const req = http.get({ ...opts, path, timeout: 20000 }, r => {
      const c = []; r.on("data", d => c.push(d));
      r.on("end", () => res({ status: r.statusCode, headers: r.headers, buf: Buffer.concat(c) }));
    });
    req.on("timeout", () => { req.destroy(); res({ status: "TIMEOUT", buf: Buffer.alloc(0) }); });
    req.on("error", e => res({ status: "ERR " + e.code, buf: Buffer.alloc(0) }));
  });
}
(async () => {
  const list = await get(HUB, "/api/klipper");
  console.log("\n== /api/klipper -> " + list.status);
  let printers = [];
  try { printers = JSON.parse(list.buf.toString()).printers || []; } catch {}
  ok(list.status === 200 && printers.length > 0, "the Hub lists proxied printer paths", printers.slice(0, 2));
  const target = printers.find(p => p.id === ID);
  ok(target && target.path === "/p/" + ID + "/", "…including a path for the printer under test", target);
  const direct = target ? new URL(target.direct) : null;
  const PR = direct ? { host: direct.hostname, port: direct.port || 80 } : null;

  console.log("\n== the page");
  const idx = await get(HUB, "/p/" + ID + "/");
  const html = idx.buf.toString("utf8");
  ok(idx.status === 200 && /fluidd/i.test(html), "GET /p/" + ID + "/ serves the printer's Fluidd index", idx.status);
  ok(!/(?:src|href)="\//.test(html), "…with no absolute asset paths, so the prefix cannot break them");
  const asset = (html.match(/src="\.\/(assets\/[^"]+)"/) || [])[1];
  ok(!!asset, "…and it names a bundle to fetch", asset);

  console.log("\n== byte fidelity");
  if (asset && PR) {
    const viaHub = await get(HUB, "/p/" + ID + "/" + asset);
    const viaLan = await get(PR, "/" + asset);
    const h = b => crypto.createHash("sha256").update(b).digest("hex").slice(0, 16);
    ok(viaHub.status === 200 && viaHub.buf.length > 1000, "the bundle comes through the proxy", viaHub.status);
    ok(h(viaHub.buf) === h(viaLan.buf),
      "…byte-identical to the printer's own copy — nothing is being rewritten",
      { hub: h(viaHub.buf), lan: h(viaLan.buf), hubLen: viaHub.buf.length, lanLen: viaLan.buf.length });
  }

  console.log("\n== the redirect that keeps relative assets honest");
  const bare = await new Promise(res => {
    const req = http.request({ ...HUB, path: "/p/" + ID, method: "GET" }, r => { r.resume(); res({ status: r.statusCode, loc: r.headers.location }); });
    req.on("error", e => res({ status: "ERR " + e.code })); req.end();
  });
  ok(bare.status === 302 && bare.loc === "/p/" + ID + "/",
    "/p/" + ID + " (no slash) redirects to /p/" + ID + "/ instead of serving one level too high", bare);

  console.log("\n== config.json — the one rewritten response");
  const cfg = await get(HUB, "/p/" + ID + "/config.json");
  let j = {};
  try { j = JSON.parse(cfg.buf.toString()); } catch {}
  ok(cfg.status === 200 && Array.isArray(j.endpoints) && j.endpoints.length === 1,
    "config.json carries exactly one endpoint", j.endpoints);
  ok(String(j.endpoints && j.endpoints[0]).endsWith("/p/" + ID),
    "…and it points back through the proxy, not at the printer's LAN IP", j.endpoints);
  ok("themePresets" in j || "blacklist" in j,
    "…while the printer's own config is preserved around it", Object.keys(j));

  console.log("\n== the WebSocket");
  const wsOk = await new Promise(res => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      ...HUB, path: "/p/" + ID + "/websocket", method: "GET", agent: false,
      headers: { Connection: "Upgrade", Upgrade: "websocket",
                 "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }
    });
    const t = setTimeout(() => { req.destroy(); res({ ok: false, why: "timeout" }); }, 15000);
    req.on("upgrade", (r, sock) => {
      const want = crypto.createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      const accept = r.headers["sec-websocket-accept"];
      // Ask Moonraker something over the socket and require a real answer, not
      // just a completed handshake. A proxy can pass the 101 and then drop the
      // frames; that failure is invisible until the page sits "connecting".
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "server.info", id: 4321 }));
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      const hdr = Buffer.from([0x81, 0x80 | payload.length]);
      sock.write(Buffer.concat([hdr, mask, masked]));
      sock.on("data", d => {
        clearTimeout(t);
        const text = d.toString("utf8");
        res({ ok: true, accept: accept === want, answered: /klippy|result|moonraker/i.test(text), sample: text.slice(0, 90) });
        sock.destroy();
      });
    });
    req.on("response", r => { clearTimeout(t); res({ ok: false, why: "no upgrade, HTTP " + r.statusCode }); });
    req.on("error", e => { clearTimeout(t); res({ ok: false, why: e.code }); });
    req.end();
  });
  ok(wsOk.ok, "the upgrade completes through the Hub", wsOk);
  ok(wsOk.accept, "…with the printer's own Sec-WebSocket-Accept, not a regenerated one", wsOk.accept);
  ok(wsOk.answered, "…and Moonraker actually answers a JSON-RPC call over it", wsOk.sample);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
