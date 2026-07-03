// server.js — U1 Print Hub  ·  v1.5.3
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "2.1.0";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const { Transform } = require("stream");
const { parseGcodeMap } = require("./parser");

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
const IS_PKG = typeof process.pkg !== "undefined";
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const ASSET_DIR = __dirname;

const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [], tip: { label: "Buy me a beer 🍺", url: "https://venmo.com/u/dgambill" } };

// Live config — editable from the Settings page, no restart needed.
let CFG, FOLDER, PRINTERS;
function loadConfig() {
  try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { CFG = { ...DEFAULT_CFG }; }
  FOLDER = path.resolve(BASE_DIR, CFG.gcodeFolder || "./gcode");
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  try { fs.mkdirSync(FOLDER, { recursive: true }); } catch {}
}
loadConfig();
const PORT = CFG.port || 4545;

// --- last-printed tracking --------------------------------------------------
// Stamps printlog.json (basename -> epoch ms) when a printer transitions INTO
// "printing". A 15s poll watches each printer's state; we only record a genuine
// new start — skipping boot-mid-print (no prior state observed) and
// resume-from-pause (paused -> printing is not a new print).
const PRINTLOG_PATH = path.join(BASE_DIR, "printlog.json");
function loadPrintLog() { try { return JSON.parse(fs.readFileSync(PRINTLOG_PATH, "utf8")); } catch { return {}; } }
function savePrintLog() { try { fs.writeFileSync(PRINTLOG_PATH, JSON.stringify(PRINTLOG, null, 2)); } catch {} }
let PRINTLOG = loadPrintLog();
const LAST_STATE = {};   // printer index -> last observed state

async function probeState(p) {
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(base + "/printer/objects/query?print_stats", { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json();
    const ps = (j.result && j.result.status && j.result.status.print_stats) || {};
    return { state: ps.state || "unknown", filename: ps.filename || "" };
  } catch { return null; }
}

async function pollPrintStarts() {
  for (let i = 0; i < PRINTERS.length; i++) {
    const s = await probeState(PRINTERS[i]);
    if (!s) continue;                       // unreachable: leave LAST_STATE so recovery doesn't fake a transition
    const prev = LAST_STATE[i];
    // genuine new start: a prior state exists, it wasn't already printing, and
    // it wasn't a pause. prev===undefined => first observation => boot-mid-print => skip.
    if (s.state === "printing" && prev !== undefined && prev !== "printing" && prev !== "paused") {
      const base = path.basename(s.filename || "");
      if (base) { PRINTLOG[base] = Date.now(); savePrintLog(); }
    }
    LAST_STATE[i] = s.state;
  }
}
setInterval(pollPrintStarts, 15000);
pollPrintStarts();   // prime LAST_STATE at startup (won't stamp — prev is undefined)

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ASSET_DIR, "public")));
// Explicit index route so the UI is served even when running from a packaged
// binary (where express.static from the snapshot can be unreliable).
app.get("/", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});

// Resolve a requested filename safely INSIDE the watched folder (no traversal).
function safeFile(name) {
  if (!name) return null;
  const p = path.resolve(FOLDER, path.basename(name));
  return p.startsWith(FOLDER) ? p : null;
}

app.get("/api/printers", (req, res) => {
  res.json(PRINTERS.map((p, i) => ({ id: i, name: p.name })));
});

app.get("/api/files", (req, res) => {
  try {
    const files = fs.readdirSync(FOLDER)
      .filter(f => /\.(gcode|gco|g)$/i.test(f))
      .map(f => {
        const st = fs.statSync(path.join(FOLDER, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, lastPrinted: PRINTLOG[f] || null };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ folder: FOLDER, files });
  } catch (e) {
    res.status(500).json({ error: "Cannot read folder " + FOLDER + " — " + e.message });
  }
});

// Serve the embedded slicer thumbnail (PNG) from a file's HEAD. Picks the
// largest PNG block; 404 if the file has none (or only non-PNG/QOI thumbnails).
app.get("/api/thumb", (req, res) => {
  const fp = safeFile(req.query.file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).end();
  let head;
  try {
    const fd = fs.openSync(fp, "r");
    try {
      const buf = Buffer.alloc(262144);           // first 256 KB is plenty
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.slice(0, n).toString("latin1");
    } finally { fs.closeSync(fd); }
  } catch { return res.status(404).end(); }

  const re = /;\s*thumbnail(?:_PNG)? begin (\d+)x(\d+)[^\n]*\n([\s\S]*?);\s*thumbnail(?:_PNG)? end/g;
  let m, best = null, bestArea = -1;
  while ((m = re.exec(head))) {
    const area = (+m[1]) * (+m[2]);
    if (area > bestArea) { bestArea = area; best = m[3]; }
  }
  if (best == null) return res.status(404).end();

  const b64 = best.replace(/^[ \t]*;[ \t]?/gm, "").replace(/\s+/g, "");
  let png;
  try { png = Buffer.from(b64, "base64"); } catch { return res.status(404).end(); }
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) return res.status(404).end(); // PNG magic
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "max-age=300");
  res.send(png);
});

app.get("/api/map", (req, res) => {
  const fp = safeFile(req.query.file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  try {
    // The Orca config block (colours + "filament used [g]") lives at the END of
    // the file, so read just the tail — turns a 200MB read into ~2MB and skips
    // the body scan entirely. Fall back to the whole file only if the colour
    // config isn't found in the tail.
    const TAIL = 3 * 1024 * 1024;
    const size = fs.statSync(fp).size;
    let text;
    if (size > TAIL) {
      const fd = fs.openSync(fp, "r");
      try {
        const buf = Buffer.alloc(TAIL);
        fs.readSync(fd, buf, 0, TAIL, size - TAIL);
        text = buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } else {
      text = fs.readFileSync(fp, "utf8");
    }
    let result = parseGcodeMap(text, { scanBody: false });
    if (result.noColors && size > TAIL) {
      // Colours weren't in the tail — fall back to a full parse (rare).
      result = parseGcodeMap(fs.readFileSync(fp, "utf8"), { scanBody: true });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rewrite the file's palette colors so each chosen color exactly equals the
// target head's loaded color. The U1 matches file-colors to loaded heads, so an
// exact match forces deterministic routing. colorMap = { paletteIndex: "#RRGGBB" }.
function rewriteColors(text, colorMap) {
  const rebuild = v => {
    const parts = v.split(";");
    for (const k in colorMap) { const i = +k; if (i >= 0 && i < parts.length) parts[i] = colorMap[k]; }
    return parts.join(";");
  };
  text = text.replace(/^(; filament_colour = )([^\r\n]*)/m, (m, p, v) => p + rebuild(v));
  text = text.replace(/^(; extruder_colour = )([^\r\n]*)/m, (m, p, v) => p + rebuild(v));
  return text;
}

// Stream a file to the printer as multipart/form-data, reporting bytes sent so
// the UI can show a real upload progress bar. Resolves on the printer's 2xx.
function uploadWithProgress(base, fp, name, job) {
  return new Promise((resolve, reject) => {
    const boundary = "----u1hub" + Math.random().toString(16).slice(2);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const fileSize = fs.statSync(fp).size;
    job.total = pre.length + fileSize + post.length;
    job.sent = 0;
    const u = new URL(base + "/server/files/upload");
    const req = http.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": job.total }
    }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => (res.statusCode < 300 ? resolve(b) : reject(new Error("Upload " + res.statusCode + ": " + b.slice(0, 160)))));
    });
    req.on("error", reject);
    req.write(pre); job.sent += pre.length;
    const fileStream = fs.createReadStream(fp);
    const counter = new Transform({ transform(chunk, _e, cb) { job.sent += chunk.length; cb(null, chunk); } });
    fileStream.on("error", reject);
    counter.on("error", reject);
    counter.on("data", chunk => { if (!req.write(chunk)) { counter.pause(); req.once("drain", () => counter.resume()); } });
    counter.on("end", () => { req.write(post); job.sent += post.length; req.end(); });
    fileStream.pipe(counter);
  });
}

const JOBS = new Map();   // jobId -> { phase, sent, total, done, error, result, ts }
const newJobId = () => "j" + Date.now() + Math.random().toString(16).slice(2, 6);

app.post("/api/print", (req, res) => {
  const { file, printer, start, map } = req.body || {};
  const fp = safeFile(file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });

  // map is { logicalToolIndex: physicalHeadIndex }. Reject two tools → same head.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
    const heads = tools.map(t => map[t]);
    if (new Set(heads).size !== heads.length) {
      return res.status(400).json({ error: "Two colors are mapped to the same head — give each its own head." });
    }
  }

  const base = String(p.url).replace(/\/+$/, "");
  const name = path.basename(fp);
  const gcode = async script => {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(script), { method: "POST" });
    if (!r.ok) throw new Error("gcode (" + r.status + "): " + (await r.text()).slice(0, 200));
  };

  // Kick the work off in the background and hand the client a job id to poll.
  const jobId = newJobId();
  const job = { phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  JOBS.set(jobId, job);
  res.json({ jobId });

  (async () => {
    try {
      await uploadWithProgress(base, fp, name, job);     // 1) upload (with progress)
      if (tools.length) {                                 // 2) toolhead mapping macros
        job.phase = "mapping";
        const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
        lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + tools.map(t => map[t]).join(","));
        lines.push("SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
        await gcode(lines.join("\n"));
      }
      if (start) { job.phase = "starting"; await gcode(`SDCARD_PRINT_FILE FILENAME="${name}"`); }
      job.result = { printer: p.name, started: !!start, mapped: tools.length };
      job.phase = "done"; job.done = true;
    } catch (e) {
      job.error = e.message; job.done = true; job.phase = "error";
    }
  })();
});

// Poll a print job's progress. Cleans the record up once a finished job is read.
app.get("/api/print-status", (req, res) => {
  const job = JOBS.get(req.query.job);
  if (!job) return res.status(404).json({ error: "No such job" });
  const out = { phase: job.phase, sent: job.sent, total: job.total, done: job.done, error: job.error, result: job.result };
  if (job.done) setTimeout(() => JOBS.delete(req.query.job), 5000);
  res.json(out);
});

// ---- Print control: pause / resume / cancel (standard Klipper macros) ----
app.post("/api/printctl", async (req, res) => {
  const { printer, action } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const cmd = { pause: "PAUSE", resume: "RESUME", cancel: "CANCEL_PRINT" }[action];
  if (!cmd) return res.status(400).json({ error: "Bad action" });
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(cmd), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

// ---- Exclude-object: live plate map + skip a single object mid-print ----
app.get("/api/plate", async (req, res) => {
  const p = PRINTERS[req.query.printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const r = await fetch(base + "/printer/objects/query?exclude_object", { method: "GET" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status });
    const eo = (((await r.json()).result || {}).status || {}).exclude_object || {};
    res.json({
      objects: (eo.objects || []).map(o => ({ name: o.name, center: o.center, polygon: o.polygon })),
      current: eo.current_object || null,
      excluded: eo.excluded_objects || []
    });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

app.post("/api/exclude", async (req, res) => {
  const { printer, name } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!name || /["\r\n]/.test(name)) return res.status(400).json({ error: "Bad object name" });
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(`EXCLUDE_OBJECT NAME=${name}`), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, excluded: name });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

// ---- Fleet: live per-head filament + status across all printers ----
// Colors come from print_task_config (the touchscreen-assigned filament, which
// persists with the physical spools until unloaded). filament_detect was wrong:
// it only reports RFID-tagged official spools, so third-party heads read blank.
function decodeHeads(ptc) {
  const ex   = ptc.filament_exist || [];
  const rgba = ptc.filament_color_rgba || [];
  const typ  = ptc.filament_type || [];
  const sub  = ptc.filament_sub_type || [];
  const off  = ptc.filament_official || [];
  return [0, 1, 2, 3].map(i => {
    const loaded = !!ex[i];
    let hex = null;
    if (loaded && rgba[i]) {
      const m = /^#?([0-9a-fA-F]{6})/.exec(rgba[i]);
      if (m) hex = "#" + m[1].toUpperCase();
    }
    return {
      loaded,
      hex,
      material: loaded ? (typ[i] || null) : null,
      sub: (loaded && sub[i] && sub[i] !== "NONE") ? sub[i] : null,
      official: !!off[i]
    };
  });
}

// ---- Per-file metadata cache -------------------------------------------------
// The touchscreen computes progress from header-corrected byte position and its
// countdown from the slicer's estimated_time. Both live in file metadata, which
// only changes when the file changes — so fetch once per (printer, file) and
// re-fetch if the file size stops matching (re-sliced under the same name).
// Verified 2026-07-02: screen showed 1% / 16:03 while display_status said 3%;
// header-corrected bytes × estimated_time reproduced the screen exactly.
const META_CACHE = {};   // key: printer name -> { file, size, start, end, est }
async function fileMeta(base, key, filename, fileSize) {
  const c = META_CACHE[key];
  if (c && c.file === filename && c.size === fileSize) return c;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/server/files/metadata?filename=" + encodeURIComponent(filename), { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const m = ((await r.json()).result) || {};
    const rec = {
      file: filename, size: fileSize,
      start: m.gcode_start_byte || 0,
      end: m.gcode_end_byte || 0,
      est: m.estimated_time || 0
    };
    META_CACHE[key] = rec;
    return rec;
  } catch { return null; }
}

async function probe(p) {
  const base = String(p.url).replace(/\/+$/, "");
  const url = base + "/printer/objects/query?print_task_config&print_stats&display_status&virtual_sdcard&heater_bed&exclude_object";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { name: p.name, online: false, error: "HTTP " + r.status };
    const j = await r.json();
    const st = (j.result && j.result.status) || {};
    const ptc = st.print_task_config || {};
    const heads = decodeHeads(ptc);
    const ps = st.print_stats || {};
    const ds = st.display_status || {};
    const vsd = st.virtual_sdcard || {};
    const hb = st.heater_bed || {};
    const eo = st.exclude_object || {};
    const plate = (eo.objects && eo.objects.length)
      ? { total: eo.objects.length, excluded: (eo.excluded_objects || []).length, current: eo.current_object || null }
      : null;
    // logical-filament -> physical-head map (first 4 entries of the table)
    const mapTable = Array.isArray(ptc.extruder_map_table) ? ptc.extruder_map_table.slice(0, 4) : null;
    // Progress: header-corrected byte position through the gcode body — this is
    // what the touchscreen shows. display_status.progress is the slicer's coarse
    // integer M73 P value and runs ahead early in a print.
    let progress = typeof ds.progress === "number" ? ds.progress : 0;
    let etaSec = null;
    if ((ps.state === "printing" || ps.state === "paused") && ps.filename) {
      if (typeof vsd.progress === "number") progress = vsd.progress;
      const meta = await fileMeta(base, p.name, ps.filename, vsd.file_size);
      if (meta && typeof vsd.file_position === "number" && meta.end > meta.start) {
        progress = Math.min(1, Math.max(0,
          (vsd.file_position - meta.start) / (meta.end - meta.start)));
      }
      // Screen-matching countdown: slicer estimate scaled by remaining fraction.
      // Deliberately mirrors the touchscreen (not self-correcting) so the Hub
      // and the screen never disagree.
      if (meta && meta.est > 0) etaSec = Math.max(0, meta.est * (1 - progress));
    }
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      filename: ps.filename || "",
      progress,
      etaSec,
      printDuration: typeof ps.print_duration === "number" ? ps.print_duration : 0,
      bed: (typeof hb.temperature === "number") ? { temp: hb.temperature, target: hb.target || 0 } : null,
      plate,
      heads, mapTable
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

app.get("/api/fleet", async (req, res) => {
  const out = await Promise.all(PRINTERS.map((p, i) => probe(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});

// ---- Farm stats: lifetime totals from each printer's Moonraker job history ----
// Moonraker keeps these on-printer (verified live on stock Snapmaker firmware);
// the Hub just aggregates on request. total_filament_used is millimeters of
// filament extruded — label it as length (m/km), never convert to grams.
app.get("/api/farm/stats", async (req, res) => {
  const per = await Promise.all(PRINTERS.map(async (p, i) => {
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
      online: on.length, total: PRINTERS.length,
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
  const per = await Promise.all(PRINTERS.map(async (p, i) => {
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
  const p = PRINTERS[id];
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
  const p = PRINTERS[id];
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
  const p = PRINTERS[printer];
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
  const out = await Promise.all(PRINTERS.map((p, i) => probeInfo(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});

// ---- Settings: read/write config from the UI (no file editing) ----
function publicCfg() {
  return { gcodeFolder: CFG.gcodeFolder || "./gcode", folderResolved: FOLDER, printers: PRINTERS, tip: CFG.tip || null, configured: PRINTERS.length > 0 };
}
app.get("/api/config", (req, res) => res.json(publicCfg()));
app.get("/api/version", (req, res) => res.json({ version: VERSION }));

app.post("/api/config", (req, res) => {
  const b = req.body || {};
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (CFG.gcodeFolder || "./gcode"),
    port: PORT,
    printers: Array.isArray(b.printers)
      ? b.printers.filter(p => p && p.url).map(p => ({ name: String(p.name || p.url), url: String(p.url) }))
      : (CFG.printers || []),
    tip: (b.tip && (b.tip.url || b.tip.label)) ? { label: String(b.tip.label || "Buy me a beer"), url: String(b.tip.url || "") } : (b.tip === null ? null : (CFG.tip || null))
  };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    loadConfig();
    res.json({ ok: true, ...publicCfg() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Auto-discovery: scan the local subnet(s) for Moonraker printers ----
function localSubnets() {
  const out = new Set();
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name] || []) {
    if (a.family === "IPv4" && !a.internal) out.add(a.address.split(".").slice(0, 3).join("."));
  }
  return [...out];
}
async function probeMoonraker(ip) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 900);
    const r = await fetch(`http://${ip}/machine/system_info`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const si = ((await r.json()).result || {}).system_info;
    if (!si) return null;
    const pi = si.product_info || {};
    const { mac } = pickIface(si.network || {});
    return { ip, url: `http://${ip}`, device_name: pi.device_name || null, machine_type: pi.machine_type || null, serial: pi.serial_number || null, mac };
  } catch { return null; }
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
  res.json({ subnets: localSubnets(), found });
});

app.listen(PORT, () => {
  const url = "http://localhost:" + PORT;
  console.log("\n  U1 Print Hub  v" + VERSION + "  →  " + url);
  console.log("  Folder:   " + FOLDER);
  console.log("  Config:   " + CONFIG_PATH);
  console.log("  Printers: " + (PRINTERS.map(p => p.name).join(", ") || "(none configured — open the page and use Settings)") + "\n");
  if (IS_PKG) {
    // Double-click launch: open the browser for the user.
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    try { require("child_process").exec(cmd); } catch {}
  }
});
