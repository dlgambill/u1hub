// Read-only: the request timeline from access.log for ONE client (the most
// recent non-local one, or the ip given), as the server saw it: arrival time
// relative to the client's first request, gap since the previous request,
// server ms, status, bytes, url. Gaps are where the phone/network is; server
// ms is where the Hub is.
const fs = require("fs"), path = require("path");
const lines = fs.readFileSync(path.join(__dirname, "..", "access.log"), "utf8").trim().split(/\r?\n/);
const rows = lines.map(l => { const m = /^(\S+) (\S+) (\S+) (\S+) (\d+) (\d+)ms (\S+)$/.exec(l); return m && { t: Date.parse(m[1]), ip: m[2], method: m[3], url: m[4], status: +m[5], ms: +m[6], bytes: m[7] }; }).filter(Boolean);
const local = ip => /^(127\.|::1|192\.168\.|10\.)/.test(ip);
let ip = process.argv[2];
if (!ip) { const remote = rows.filter(r => !local(r.ip)); ip = remote.length ? remote[remote.length - 1].ip : rows[rows.length - 1].ip; }
const mine = rows.filter(r => r.ip === ip);
// split into "sessions" on gaps > 20 s; show the last one (or all with --all)
const sessions = []; let cur = [];
for (const r of mine) { if (cur.length && r.t - cur[cur.length - 1].t > 20000) { sessions.push(cur); cur = []; } cur.push(r); }
if (cur.length) sessions.push(cur);
const show = process.argv.includes("--all") ? sessions : sessions.slice(-1);
console.log("client " + ip + ": " + mine.length + " requests, " + sessions.length + " session(s)");
for (const s of show) {
  const t0 = s[0].t;
  console.log("\n== session starting " + new Date(t0).toLocaleTimeString() + " (" + s.length + " requests, " + ((s[s.length - 1].t - t0) / 1000).toFixed(1) + " s span)");
  console.log("  +ms    gap  srv-ms  st    bytes  url");
  let prev = t0;
  for (const r of s) {
    console.log(String(r.t - t0).padStart(6) + " " + String(r.t - prev).padStart(6) + " " + String(r.ms).padStart(7) + "  " + String(r.status).padEnd(3) + " " + String(r.bytes).padStart(8) + "  " + r.url.slice(0, 90));
    prev = r.t;
  }
  const srv = s.reduce((n, r) => n + r.ms, 0);
  console.log("  server time summed: " + srv + " ms over " + s.length + " requests; wall span " + (s[s.length - 1].t - t0) + " ms");
}
