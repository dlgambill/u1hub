// Diagnostic: what is the live Hub's event loop busy with? Attaches the
// inspector to a running node (localhost only), takes a CPU profile for N
// seconds, prints the hottest functions by self time and the longest
// uninterrupted stretches. Usage: node loopprof.js <pid> <seconds>
const http = require("http");
const pid = Number(process.argv[2]), secs = Number(process.argv[3] || 12);
process._debugProcess(pid);
setTimeout(async () => {
  const list = await new Promise((res, rej) => http.get("http://127.0.0.1:9229/json/list", r => { let b = ""; r.on("data", c => b += c); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  ws.onopen = async () => {
    await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 2000 }); await send("Profiler.start");
    console.log("profiling", pid, "for", secs, "s");
    await new Promise(r => setTimeout(r, secs * 1000));
    const { profile } = await send("Profiler.stop");
    const nodes = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    const dt = profile.timeDeltas; let total = 0;
    for (let i = 0; i < profile.samples.length; i++) { const n = nodes.get(profile.samples[i]); const k = n.callFrame.functionName + " @ " + (n.callFrame.url || "").split(/[\\/]/).slice(-2).join("/") + ":" + n.callFrame.lineNumber; self.set(k, (self.get(k) || 0) + (dt[i] || 0)); total += dt[i] || 0; }
    console.log("total sampled ms:", Math.round(total / 1000));
    [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, v]) => console.log(String(Math.round(v / 1000)).padStart(7) + " ms  " + k));
    // longest single-frame stretches (consecutive samples in the same node)
    let runs = [], cur = null, len = 0;
    for (let i = 0; i < profile.samples.length; i++) { if (profile.samples[i] === cur) len += dt[i] || 0; else { if (cur != null) runs.push([len, cur]); cur = profile.samples[i]; len = dt[i] || 0; } }
    runs.push([len, cur]); runs.sort((a, b) => b[0] - a[0]);
    console.log("longest uninterrupted stretches:");
    runs.slice(0, 6).forEach(([l, nid]) => { const n = nodes.get(nid); console.log("  " + Math.round(l / 1000) + " ms  " + n.callFrame.functionName + " @ " + (n.callFrame.url || "").split(/[\\/]/).slice(-2).join("/") + ":" + n.callFrame.lineNumber); });
    ws.close(); process.exit(0);
  };
}, 800);
