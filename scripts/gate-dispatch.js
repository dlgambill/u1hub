// Live gate for the v2.22 Dispatch changes, against the throwaway Hub on 4546
// (boot it with scripts\boot-4546.cmd; its state is isolated from production so
// the lock/unlock this does never touches the real farm's schedule). The
// harness proves the logic against mocks; this proves the REAL server boots
// with the change and serves it — schedule_mode / locked / new_since_lock on a
// live plan, the lock endpoint round-tripping, and the actual client module
// carrying the new controls. "Green is not verified."
const http = require("http");
const HUB = { host: "127.0.0.1", port: 4546 };
let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra).slice(0, 300))); }
};
function req(method, path, body) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const headers = data ? { "Content-Type": "application/json", "Content-Length": data.length } : {};
  return new Promise(res => {
    const r = http.request({ ...HUB, method, path, headers, timeout: 20000 }, resp => {
      const c = []; resp.on("data", d => c.push(d));
      resp.on("end", () => {
        const buf = Buffer.concat(c), text = buf.toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch {}
        res({ status: resp.statusCode, json, text });
      });
    });
    r.on("timeout", () => { r.destroy(); res({ status: "TIMEOUT" }); });
    r.on("error", e => res({ status: "ERR " + e.code }));
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  console.log("\n== the real build is running");
  const ver = await req("GET", "/api/version");
  ok(ver.status === 200 && ver.json && ver.json.version === "2.22.0",
    "the throwaway Hub reports v2.22.0", ver.json);

  console.log("\n== a live plan carries the fluid/locked contract");
  let plan = await req("GET", "/api/dispatch/plan");
  ok(plan.status === 200 && plan.json, "GET /api/dispatch/plan answers", plan.status);
  ok(plan.json && plan.json.schedule_mode === "fluid", "it is fluid to start", plan.json && plan.json.schedule_mode);
  ok(plan.json && plan.json.locked === false, "…and reports itself unlocked", plan.json && plan.json.locked);
  ok(plan.json && Array.isArray(plan.json.new_since_lock),
    "…and always carries a new_since_lock array (empty while fluid)", plan.json && plan.json.new_since_lock);

  console.log("\n== the lock endpoint round-trips on the real server");
  const lk = await req("POST", "/api/dispatch/lock", { lock: true });
  ok(lk.status === 200 && lk.json && lk.json.locked === true && typeof lk.json.frozen_slots === "number",
    "POST /api/dispatch/lock freezes and reports how many slots it snapshotted", lk.json);
  plan = await req("GET", "/api/dispatch/plan");
  ok(plan.json && plan.json.locked === true && plan.json.schedule_mode === "locked",
    "the plan now serves itself as locked", plan.json && { l: plan.json.locked, m: plan.json.schedule_mode });
  const un = await req("POST", "/api/dispatch/lock", { lock: false });
  ok(un.status === 200 && un.json && un.json.locked === false, "…and unlock clears it", un.json);
  plan = await req("GET", "/api/dispatch/plan");
  ok(plan.json && plan.json.locked === false && plan.json.schedule_mode === "fluid",
    "…leaving the board fluid again (state restored, farm untouched)", plan.json && plan.json.schedule_mode);

  console.log("\n== the client actually served carries the new controls");
  const page = await req("GET", "/");
  const m = (page.text || "").match(/\/modules\/dispatch-ui\.js\?v=([0-9.]+)/);
  ok(m && m[1] === "2.22.0", "the page loads dispatch-ui.js stamped v2.22.0 (no stale cache)", m && m[0]);
  const ui = await req("GET", (m ? m[0] : "/modules/dispatch-ui.js"));
  const js = ui.text || "";
  ok(/dsp-glock/.test(js) && /id="dsp-glockbtn"/.test(js), "the served module has the fluid/locked toggle", /dsp-glock/.test(js));
  ok(/data-dsp-prio/.test(js), "…the 1-5 priority picker", /data-dsp-prio/.test(js));
  ok(/dsp-rowrun/.test(js), "…and the printing-now lane highlight", /dsp-rowrun/.test(js));

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
