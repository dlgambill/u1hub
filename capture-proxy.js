// capture-proxy.js — U1 Print Hub diagnostic
// Sits between Snapmaker Orca and ONE real U1. Forwards every request to the
// printer (so Orca behaves normally) and logs each one — so we can see the
// exact call that carries the toolhead mapping.
//
// Usage:   node capture-proxy.js http://<printer-ip> [listenPort]
// Example: node capture-proxy.js http://192.168.1.51 7125
//
// Then in Orca, set that printer's host to  http://<this-machine-ip>:7125
// (keep host type = Klipper/Moonraker), slice, set your toolhead mapping, and
// hit Send. Everything lands in capture-<timestamp>.log next to this file.

const http = require("http");
const fs = require("fs");
const os = require("os");
const { URL } = require("url");
const { Transform } = require("stream");

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name] || [])
    if (a.family === "IPv4" && !a.internal) out.push(a.address);
  return out;
}

const TARGET = process.argv[2];
const PORT = parseInt(process.argv[3] || "7125", 10);
if (!TARGET || !/^https?:\/\//.test(TARGET)) {
  console.error("Usage: node capture-proxy.js http://<printer-ip> [listenPort]");
  process.exit(1);
}
const target = new URL(TARGET);
const TARGET_PORT = target.port || (target.protocol === "https:" ? 443 : 80);
const LOGFILE = "capture-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log";

function log(s) {
  const line = s.endsWith("\n") ? s : s + "\n";
  process.stdout.write(line);
  fs.appendFileSync(LOGFILE, line);
}
const stamp = () => new Date().toISOString().slice(11, 23);
const clean = b => b.toString("latin1").replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, "·");

log("─".repeat(64));
log("  Capture proxy  →  " + TARGET + "  (port " + TARGET_PORT + ")");
log("  Listening on   :" + PORT);
log("  Logging to     " + LOGFILE);
const ips = lanIPs();
if (ips.length) {
  log("  In Orca, point this printer's host at:");
  ips.forEach(ip => log("        http://" + ip + ":" + PORT));
} else {
  log("  In Orca, point this printer's host at  http://THIS-MACHINE-IP:" + PORT);
}
log("─".repeat(64) + "\n");

// Build a passthrough that taps the HEAD and TAIL of a big stream without
// holding the whole thing in memory (the gcode body is hundreds of MB).
function headTailTap(onDone) {
  const CAP = 16 * 1024;
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), total = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (head.length < CAP) head = Buffer.concat([head, chunk.slice(0, CAP - head.length)]);
      tail = Buffer.concat([tail, chunk]).slice(-CAP);
      cb(null, chunk);
    }
  });
  t.on("end", () => onDone({ head, tail, total }));
  return t;
}

const server = http.createServer((req, res) => {
  const isUpload = /\/server\/files\/upload/.test(req.url);
  const opts = {
    host: target.hostname, port: TARGET_PORT, path: req.url, method: req.method,
    headers: { ...req.headers, host: target.host }
  };

  log(stamp() + "  → " + req.method + " " + req.url);
  // Log a few headers that matter for understanding the call.
  ["content-type", "content-length", "x-api-key", "authorization"].forEach(h => {
    if (req.headers[h]) log("       " + h + ": " + req.headers[h]);
  });

  const fwd = http.request(opts, up => {
    log(stamp() + "  ← " + up.statusCode + " for " + req.method + " " + req.url);
    res.writeHead(up.statusCode, up.headers);
    let rb = Buffer.alloc(0);
    up.on("data", d => { if (rb.length < 4096) rb = Buffer.concat([rb, d]); });
    up.on("end", () => { if (rb.length) log("       resp: " + clean(rb).replace(/\s+/g, " ").slice(0, 1500)); });
    up.pipe(res);
  });
  fwd.on("error", e => {
    log("       ‼ forward error: " + e.message);
    try { res.writeHead(502); res.end("capture-proxy: " + e.message); } catch {}
  });

  if (isUpload) {
    // Stream straight through; log only the head + tail (multipart field
    // boundaries and small text fields live there — the giant gcode bytes
    // are in the middle and we skip them).
    const tap = headTailTap(({ head, tail, total }) => {
      log("       upload body ≈ " + total + " bytes");
      log("       ── multipart HEAD ──\n" + clean(head));
      log("       ── multipart TAIL ──\n" + clean(tail) + "\n");
    });
    req.pipe(tap).pipe(fwd);
  } else {
    const chunks = [];
    req.on("data", d => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length) log("       body: " + clean(body).replace(/\s+/g, " ").slice(0, 4000));
      fwd.end(body);
    });
    req.on("error", () => fwd.end());
  }
});

// WebSocket / upgrade passthrough so Orca stays "connected" while we capture.
server.on("upgrade", (req, clientSocket, head) => {
  log(stamp() + "  ⇅ WebSocket upgrade " + req.url + " (passthrough)");
  const opts = {
    host: target.hostname, port: TARGET_PORT, path: req.url, method: "GET",
    headers: { ...req.headers, host: target.host }
  };
  const proxyReq = http.request(opts);
  proxyReq.on("upgrade", (proxyRes, serverSocket, proxyHead) => {
    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      Object.entries(proxyRes.headers).map(([k, v]) => k + ": " + v).join("\r\n") +
      "\r\n\r\n"
    );
    if (proxyHead && proxyHead.length) serverSocket.unshift(proxyHead);
    if (head && head.length) serverSocket.write(head);
    serverSocket.pipe(clientSocket);
    clientSocket.pipe(serverSocket);
    serverSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => serverSocket.destroy());
  });
  proxyReq.on("error", e => { log("       ‼ ws error: " + e.message); clientSocket.destroy(); });
  proxyReq.end();
});

server.listen(PORT, () => log(stamp() + "  ready — waiting for Orca…\n"));
