// core/telemetry.js — farm stats, history, temperature trends, per-printer stats, bed temp
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const path = require("path");

module.exports = function (hub) {
const { app } = hub;


// ---- Farm stats: lifetime totals from each printer's Moonraker job history ----
// Moonraker keeps these on-printer (verified live on stock Snapmaker firmware);
// the Hub just aggregates on request. total_filament_used is millimeters of
// filament extruded — label it as length (m/km), never convert to grams.
app.get("/api/farm/stats", async (req, res) => {
  const per = await Promise.all(hub.PRINTERS.map(async (p, i) => {
    const base = String(p.url).replace(/\/+$/, "");
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(base + "/server/history/totals", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) return { id: i, name: p.name, online: false };
      const t = (((await r.json()).result) || {}).job_totals || {};
      return {
        id: i, name: p.name, online: true,
        jobs: t.total_jobs || 0,
        printTime: t.total_print_time || 0,     // seconds, heaters-on print time
        totalTime: t.total_time || 0,           // seconds, incl. pauses/heatup
        filamentMm: t.total_filament_used || 0, // millimeters
        longestJob: t.longest_job || 0          // seconds
      };
    } catch { return { id: i, name: p.name, online: false }; }
  }));
  const on = per.filter(x => x.online);
  res.json({
    printers: per,
    fleet: {
      online: on.length, total: hub.PRINTERS.length,
      jobs: on.reduce((a, x) => a + x.jobs, 0),
      printTime: on.reduce((a, x) => a + x.printTime, 0),
      filamentMm: on.reduce((a, x) => a + x.filamentMm, 0),
      longestJob: on.reduce((a, x) => Math.max(a, x.longestJob), 0)
    }
  });
});


// ---- Farm history: recent jobs across all printers, newest first --------------
app.get("/api/farm/history", async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const per = await Promise.all(hub.PRINTERS.map(async (p, i) => {
    const base = String(p.url).replace(/\/+$/, "");
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(base + "/server/history/list?limit=" + limit + "&order=desc", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) return [];
      const jobs = ((((await r.json()).result) || {}).jobs) || [];
      return jobs.map(j => ({
        printer: p.name, id: i,
        filename: j.filename || "",
        status: j.status || "",                 // completed | cancelled | error | in_progress
        start: j.start_time || 0,               // epoch seconds
        duration: j.print_duration || 0,        // seconds
        filamentMm: j.filament_used || 0
      }));
    } catch { return []; }
  }));
  const all = per.flat().sort((a, b) => (b.start || 0) - (a.start || 0)).slice(0, limit);
  res.json(all);
});


// ---- Per-printer temperature trends -------------------------------------------
// Moonraker natively retains ~20 min of rolling temp history (verified live on
// stock firmware, ~110 KB raw). The Hub downsamples to ≤120 points per sensor so
// the panel stays phone-friendly. Sensor names are passed through as-is — only
// heater_bed is hardware-confirmed on the U1 so far, so nothing is hardcoded.
app.get("/api/ptrends", async (req, res) => {
  const id = Number(req.query.id);
  const p = hub.PRINTERS[id];
  if (!p) return res.status(400).json({ error: "bad id" });
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(base + "/server/temperature_store", { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return res.status(502).json({ error: "printer replied " + r.status });
    const result = ((await r.json()).result) || {};
    const MAXPTS = 120;
    const ds = arr => {
      if (!Array.isArray(arr)) return [];
      if (arr.length <= MAXPTS) return arr;
      const step = arr.length / MAXPTS, out = [];
      for (let i = 0; i < MAXPTS; i++) out.push(arr[Math.floor(i * step)]);
      return out;
    };
    const sensors = {};
    for (const [name, v] of Object.entries(result)) {
      if (v && Array.isArray(v.temperatures)) {
        sensors[name] = {
          temps: ds(v.temperatures).map(x => Math.round(x * 10) / 10),
          samples: v.temperatures.length   // Moonraker samples ~1/sec → seconds of history
        };
      }
    }
    res.json({ sensors });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});


// ---- Per-printer lifetime stats + recent jobs ----------------------------------
app.get("/api/pstats", async (req, res) => {
  const id = Number(req.query.id);
  const p = hub.PRINTERS[id];
  if (!p) return res.status(400).json({ error: "bad id" });
  const base = String(p.url).replace(/\/+$/, "");
  const get = async path => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(base + path, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) throw new Error("printer replied " + r.status);
    return (await r.json()).result || {};
  };
  try {
    const [tot, hist] = await Promise.all([
      get("/server/history/totals"),
      get("/server/history/list?limit=10&order=desc")
    ]);
    const t = tot.job_totals || {};
    res.json({
      jobs: t.total_jobs || 0,
      printTime: t.total_print_time || 0,      // seconds
      filamentMm: t.total_filament_used || 0,  // millimeters (length, not grams)
      longestJob: t.longest_job || 0,
      recent: (hist.jobs || []).map(j => ({
        filename: j.filename || "",
        status: j.status || "",
        start: j.start_time || 0,
        duration: j.print_duration || 0
      }))
    });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});


// ---- Set bed temperature on a printer (M140 — standard, no wait) ----
app.post("/api/bedtemp", async (req, res) => {
  const { printer, temp } = req.body || {};
  const p = hub.PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const t = Number(temp);
  if (!Number.isFinite(t) || t < 0 || t > 120) return res.status(400).json({ error: "Temp must be 0–120 °C" });
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent("M140 S" + Math.round(t)), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, printer: p.name, target: Math.round(t) });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});
};
