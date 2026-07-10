// server.js — U1 Print Hub  ·  v2.5.0
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "2.5.0";

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
  if (FARM_READY) farmWsRestart(); // reconnect sockets to the new printer list
  // (FARM_READY is a hoisted var — falsy during the initial top-of-file
  // loadConfig(), so sockets first connect once the farm section is defined)
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

// --- print queue --------------------------------------------------------------
// A single shared "up next" list (queue.json, array of {id, file, added}).
// Reference-only by design: the Hub never auto-starts queued jobs — the U1
// needs its plate cleared between prints, so starting is always a human tap.
// When a print is STARTED for a file that's in the queue, the first matching
// entry is removed automatically (upload-without-start leaves the queue alone).
const QUEUE_PATH = path.join(BASE_DIR, "queue.json");
function loadQueue() { try { const q = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")); return Array.isArray(q) ? q : []; } catch { return []; } }
function saveQueue() { try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(QUEUE, null, 2)); } catch {} }
let QUEUE = loadQueue();
function dequeueFile(name) {
  const i = QUEUE.findIndex(e => e.file === name);
  if (i !== -1) { QUEUE.splice(i, 1); saveQueue(); }
}

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
// Access gate — fronts everything below (static included). Modes and the
// off-switch live in auth.json; see auth.js for the design notes.
require("./auth.js")(app, express, BASE_DIR, ASSET_DIR);
app.use(express.static(path.join(ASSET_DIR, "public")));
// Explicit index route so the UI is served even when running from a packaged
// binary (where express.static from the snapshot can be unreliable).
app.get("/", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});
// FS mix planner: same explicit-route treatment for the packaged binary, then
// the module mounts /api/fs-colors/analyze and /api/fs-colors/solve.
app.get("/fs-colors.html", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "fs-colors.html"), "utf8")); }
  catch (e) { res.status(500).send("fs-colors.html not found"); }
});
require("./fs-colors.js")(app, express);

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

// --- queue routes -------------------------------------------------------------
app.get("/api/queue", (req, res) => res.json({ queue: QUEUE }));

app.post("/api/queue", (req, res) => {
  const fp = safeFile((req.body || {}).file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  QUEUE.push({ id: Math.random().toString(36).slice(2, 10), file: path.basename(fp), added: Date.now() });
  saveQueue();
  res.json({ ok: true, queue: QUEUE });
});

app.post("/api/queue/remove", (req, res) => {
  const i = QUEUE.findIndex(e => e.id === (req.body || {}).id);
  if (i === -1) return res.status(404).json({ error: "Not in queue" });
  QUEUE.splice(i, 1); saveQueue();
  res.json({ ok: true, queue: QUEUE });
});

app.post("/api/queue/reorder", (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids must be an array" });
  const byId = new Map(QUEUE.map(e => [e.id, e]));
  const next = ids.map(id => byId.get(id)).filter(Boolean);
  QUEUE.forEach(e => { if (!next.includes(e)) next.push(e); }); // never drop entries the client didn't know about
  QUEUE = next; saveQueue();
  res.json({ ok: true, queue: QUEUE });
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
      if (start) { job.phase = "starting"; await gcode(`SDCARD_PRINT_FILE FILENAME="${name}"`); dequeueFile(name); }
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
  const multi = ptc.filament_color_multi || [];
  return [0, 1, 2, 3].map(i => {
    const loaded = !!ex[i];
    let hex = null;
    if (loaded && rgba[i]) {
      const m = /^#?([0-9a-fA-F]{6})/.exec(rgba[i]);
      if (m) hex = "#" + m[1].toUpperCase();
    }
    // Multi-color spools: filament_color_multi carries {nums, colors[], mode}.
    // Hardware-confirmed as the READ path (single-color spools report nums:1);
    // pass extra colors through so the UI can render gradient swatches. The
    // WRITE path for multi-color is unknown (SET_PRINT_FILAMENT_CONFIG silently
    // ignores unrecognized params, so it can't be probed) — display only.
    let colors = null;
    const mc = multi[i];
    if (loaded && mc && mc.nums > 1 && Array.isArray(mc.colors) && mc.colors.length > 1) {
      colors = mc.colors
        .map(c => /^#?([0-9a-fA-F]{6})/.exec(String(c)))
        .filter(Boolean)
        .map(m2 => "#" + m2[1].toUpperCase());
      if (colors.length < 2) colors = null;
    }
    return {
      loaded,
      hex,
      colors,
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
    let thumb = null;
    if (Array.isArray(m.thumbnails) && m.thumbnails.length) {
      const t = m.thumbnails.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
      if (t && t.relative_path) thumb = String(t.relative_path);
    }
    const rec = {
      file: filename, size: fileSize,
      start: m.gcode_start_byte || 0,
      end: m.gcode_end_byte || 0,
      est: m.estimated_time || 0,
      thumb
    };
    META_CACHE[key] = rec;
    return rec;
  } catch { return null; }
}

// Shape raw Klipper status objects into one fleet-card record. Used by both
// the HTTP probe and the realtime websocket cache — same math either way.
async function shapeStatus(p, st, base) {
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
    // Layer counter — print_stats.info was confirmed live on real hardware
    // (FIFA print reported current_layer 216 / total_layer 302 mid-print).
    const info = ps.info || {};
    const layer = (typeof info.current_layer === "number" && typeof info.total_layer === "number" && info.total_layer > 0)
      ? { cur: info.current_layer, total: info.total_layer } : null;
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      // Firmware error text (print_stats.message) so failures say WHY on the card.
      message: (ps.state === "error" && ps.message) ? String(ps.message).slice(0, 200) : "",
      filename: ps.filename || "",
      progress,
      etaSec,
      layer,
      printDuration: typeof ps.print_duration === "number" ? ps.print_duration : 0,
      bed: (typeof hb.temperature === "number") ? { temp: hb.temperature, target: hb.target || 0 } : null,
      plate,
      heads, mapTable
    };
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
    return await shapeStatus(p, st, base);
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

// ---- Realtime farm state: websocket push with HTTP fallback -----------------
// Verified on hardware 2026-07-03: stock Snapmaker firmware accepts websocket
// connections and a printer.objects.subscribe pushes notify_status_update for
// print_stats / display_status / virtual_sdcard etc. (126 events observed in a
// 32 s mid-print capture). print_task_config was NOT observed broadcasting when
// a color changed on the touchscreen, so colors are reconciled by a slow HTTP
// re-query instead of trusting the socket for them.
//
// Uses Node's built-in browser-style WebSocket client (22.4+; pkg targets
// node22, so identical in the packaged exe). Each printer gets one socket with
// exponential-backoff reconnect. If a socket is down, the fleet path falls back
// to the same HTTP probe the Hub has always used — worst case is v2.3.0
// behavior, never worse.
const FARM_SUB = { print_task_config: null, print_stats: null, display_status: null,
                   virtual_sdcard: null, heater_bed: null, exclude_object: null };
const FARMWS = new Map();   // idx -> { ws, status, raw, seenAt, backoff, timer, epoch }
var FARM_READY = false;     // var (hoisted): loadConfig runs before this section
let FARM_EPOCH = 0;         // bumped on restart so stale sockets ignore themselves
const WS_FRESH_MS = 10000;  // socket data older than this -> fall back to HTTP

function farmWsConnect(idx) {
  const p = PRINTERS[idx];
  if (!p || typeof WebSocket === "undefined") return;
  const rec = FARMWS.get(idx) || { raw: {}, backoff: 0 };
  rec.epoch = FARM_EPOCH;
  rec.status = "connecting";
  FARMWS.set(idx, rec);
  const wsUrl = String(p.url).replace(/\/+$/, "").replace(/^http/, "ws") + "/websocket";
  let ws;
  try { ws = new WebSocket(wsUrl); } catch { return farmWsScheduleReconnect(idx); }
  rec.ws = ws;
  const myEpoch = rec.epoch;
  ws.onopen = () => {
    if (myEpoch !== FARM_EPOCH) { try { ws.close(); } catch {} return; }
    rec.status = "open"; rec.backoff = 0;
    try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "printer.objects.subscribe", params: { objects: FARM_SUB }, id: 1 })); } catch {}
  };
  ws.onmessage = (ev) => {
    if (myEpoch !== FARM_EPOCH) return;
    let j; try { j = JSON.parse(ev.data); } catch { return; }
    // Subscribe response carries a full snapshot of every requested object.
    if (j.id === 1 && j.result && j.result.status) {
      rec.raw = j.result.status; rec.seenAt = Date.now(); farmMarkDirty(); return;
    }
    // Incremental updates: params[0] holds per-object partial field sets.
    if (j.method === "notify_status_update" && Array.isArray(j.params) && j.params[0]) {
      const part = j.params[0];
      for (const k of Object.keys(part)) {
        if (!(k in FARM_SUB)) continue;
        rec.raw[k] = Object.assign({}, rec.raw[k], part[k]);
      }
      rec.seenAt = Date.now(); farmMarkDirty();
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (myEpoch !== FARM_EPOCH) return;
    rec.status = "closed";
    farmWsScheduleReconnect(idx);
  };
}
function farmWsScheduleReconnect(idx) {
  const rec = FARMWS.get(idx);
  if (!rec || rec.epoch !== FARM_EPOCH) return;
  rec.backoff = Math.min(30000, (rec.backoff || 1000) * 2);
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => farmWsConnect(idx), rec.backoff);
}
function farmWsRestart() {
  FARM_EPOCH++;
  for (const [, rec] of FARMWS) { clearTimeout(rec.timer); try { rec.ws && rec.ws.close(); } catch {} }
  FARMWS.clear();
  (PRINTERS || []).forEach((_, i) => farmWsConnect(i));
}
FARM_READY = true;
farmWsRestart();

// Colors don't broadcast (hardware-observed), so re-query print_task_config
// over HTTP every 20 s per connected printer and splice it into the socket
// cache. Touchscreen color changes therefore appear within one reconcile tick.
setInterval(() => {
  for (const [idx, rec] of FARMWS) {
    if (rec.status !== "open" || !rec.seenAt) continue;
    const p = PRINTERS[idx]; if (!p) continue;
    const base = String(p.url).replace(/\/+$/, "");
    fetch(base + "/printer/objects/query?print_task_config")
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const ptc = j && j.result && j.result.status && j.result.status.print_task_config;
        if (ptc) {
          const before = JSON.stringify(rec.raw.print_task_config || {});
          rec.raw.print_task_config = ptc;
          if (JSON.stringify(ptc) !== before) farmMarkDirty();
        }
      }).catch(() => {});
  }
}, 20000);

// Disk usage per printer — /server/files/directory?extended=true returned 200
// with disk totals on live hardware (probe session). Slow-moving: 60 s cadence.
const DISK_CACHE = new Map(); // idx -> { free, total, at }
async function diskPoll() {
  for (let i = 0; i < (PRINTERS || []).length; i++) {
    const p = PRINTERS[i];
    const base = String(p.url).replace(/\/+$/, "");
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(base + "/server/files/directory?extended=true", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const du = (((await r.json()).result) || {}).disk_usage || {};
      const free = (typeof du.free === "number") ? du.free : (typeof du.available === "number" ? du.available : null);
      const total = (typeof du.total === "number") ? du.total : null;
      if (free !== null) DISK_CACHE.set(i, { free, total, at: Date.now() });
    } catch {}
  }
}
setInterval(diskPoll, 60000);
setTimeout(diskPoll, 3000);

// One fleet-card record per printer: fresh socket data shapes instantly with
// zero HTTP; otherwise fall back to the classic HTTP probe with a short cache
// so SSE broadcasts can't hammer offline printers with timeout storms.
const PROBE_CACHE = new Map(); // idx -> { data, at }
async function probeCached(p, idx) {
  const rec = FARMWS.get(idx);
  const base = String(p.url).replace(/\/+$/, "");
  let data;
  if (rec && rec.status === "open" && rec.seenAt && (Date.now() - rec.seenAt) < WS_FRESH_MS) {
    data = await shapeStatus(p, rec.raw, base);
  } else {
    const c = PROBE_CACHE.get(idx);
    if (c && (Date.now() - c.at) < 4000) { data = c.data; }
    else { data = await probe(p); PROBE_CACHE.set(idx, { data, at: Date.now() }); }
  }
  const disk = DISK_CACHE.get(idx);
  if (disk && data && data.online) { data.diskFree = disk.free; data.diskTotal = disk.total; }
  return data;
}
async function fleetSnapshot() {
  return Promise.all((PRINTERS || []).map((p, i) => probeCached(p, i).then(r => ({ id: i, ...r }))));
}

app.get("/api/fleet", async (req, res) => {
  res.json(await fleetSnapshot());
});

// ---- Server-sent events: push fleet state to browsers the moment it changes.
// The page falls back to its 5 s poll automatically if this stream drops.
const SSE_CLIENTS = new Set();
app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 4000\n\n");
  SSE_CLIENTS.add(res);
  req.on("close", () => SSE_CLIENTS.delete(res));
});
let SSE_LAST = "", SSE_TIMER = null, SSE_BUSY = false;
function farmMarkDirty() {
  if (SSE_TIMER) return;                    // debounce: batch bursts into one push
  SSE_TIMER = setTimeout(sseBroadcast, 300);
}
async function sseBroadcast() {
  SSE_TIMER = null;
  if (SSE_BUSY || SSE_CLIENTS.size === 0) return;
  SSE_BUSY = true;
  try {
    const snap = JSON.stringify(await fleetSnapshot());
    if (snap !== SSE_LAST) {
      SSE_LAST = snap;
      for (const c of SSE_CLIENTS) { try { c.write("data: " + snap + "\n\n"); } catch {} }
    }
  } catch {} finally { SSE_BUSY = false; }
}
// Slow safety tick: catches drift the sockets don't broadcast (bed temp on
// HTTP-only printers, disk, reconciled colors) and keeps streams warm.
setInterval(() => { farmMarkDirty(); }, 5000);
setInterval(() => { for (const c of SSE_CLIENTS) { try { c.write(": hb\n\n"); } catch {} } }, 20000);

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

// ---- Gcode thumbnails -------------------------------------------------------
// Snapmaker Orca embeds base64 PNG previews (48x48 and 300x300) in gcode
// header comments within the first 256 KB — confirmed on real sliced files.
// /api/thumb extracts the largest one from a LOCAL file in the gcode folder.
// /api/pthumb serves a thumbnail for a printer's ACTIVE file: it prefers the
// local copy (same verified extraction) and falls back to Moonraker's
// metadata thumbnails if the printer reports them (optional; a 404 just means
// the UI shows no image).
const THUMB_CACHE = new Map(); // key -> Buffer|null
function thumbCachePut(key, val) {
  THUMB_CACHE.set(key, val);
  if (THUMB_CACHE.size > 300) THUMB_CACHE.delete(THUMB_CACHE.keys().next().value);
}
function extractThumb(buf) {
  const head = buf.toString("latin1");
  const re = /; thumbnail begin (\d+)[x ](\d+) \d+\r?\n([\s\S]*?); thumbnail end/g;
  let best = null, m;
  while ((m = re.exec(head))) {
    const w = +m[1];
    if (!best || w > best.w) best = { w, body: m[3] };
  }
  if (!best) return null;
  const b64 = best.body.split(/\r?\n/).map(l => l.replace(/^;\s?/, "").trim()).join("");
  try {
    const png = Buffer.from(b64, "base64");
    // PNG magic check — refuse to serve garbage if the header was mangled
    return (png.length > 8 && png[0] === 0x89 && png[1] === 0x50) ? png : null;
  } catch { return null; }
}
function localThumb(name) {
  const full = path.join(FOLDER, path.basename(name));
  let stat; try { stat = fs.statSync(full); } catch { return null; }
  const key = "L:" + name + ":" + stat.mtimeMs;
  if (THUMB_CACHE.has(key)) return THUMB_CACHE.get(key);
  let png = null;
  try {
    const fd = fs.openSync(full, "r");
    const buf = Buffer.alloc(Math.min(262144, stat.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    png = extractThumb(buf);
  } catch {}
  thumbCachePut(key, png);
  return png;
}
app.get("/api/thumb", (req, res) => {
  const name = path.basename(String(req.query.file || ""));
  if (!/\.gcode$/i.test(name)) return res.status(400).end();
  const png = localThumb(name);
  if (!png) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=86400").type("png").send(png);
});
app.get("/api/pthumb", async (req, res) => {
  const p = PRINTERS[+req.query.id];
  const filename = String(req.query.file || "");
  if (!p || !filename) return res.status(400).end();
  // 1) local copy of the same file — verified extraction path
  const local = localThumb(path.basename(filename));
  if (local) return res.set("Cache-Control", "public, max-age=3600").type("png").send(local);
  // 2) printer-side metadata thumbnail (optional Moonraker feature)
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const meta = await fileMeta(base, p.name, filename, undefined);
    if (!meta || !meta.thumb) return res.status(404).end();
    const dir = filename.includes("/") ? filename.slice(0, filename.lastIndexOf("/") + 1) : "";
    const key = "P:" + p.name + ":" + filename;
    if (THUMB_CACHE.has(key)) {
      const c = THUMB_CACHE.get(key);
      return c ? res.set("Cache-Control", "public, max-age=3600").type("png").send(c) : res.status(404).end();
    }
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/server/files/gcodes/" + dir + meta.thumb, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) { thumbCachePut(key, null); return res.status(404).end(); }
    const png = Buffer.from(await r.arrayBuffer());
    thumbCachePut(key, png);
    res.set("Cache-Control", "public, max-age=3600").type("png").send(png);
  } catch { res.status(404).end(); }
});

// ---- Filament color: set a slot's color from the Hub -----------------------
// Verified live 2026-07-03: the touchscreen itself issues this exact gcode
// (captured in /server/gcode_store when a color was changed on-screen):
//   SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER='3' FILAMENT_COLOR_RGBA='39FF14FF' SAVE='1'
// The Hub replays it via /printer/gcode/script, then reads print_task_config
// back and only reports success once the printer confirms the new color.
// Guards match touchscreen behavior: idle printers only, loaded slots only.
app.post("/api/setcolor", async (req, res) => {
  const { printer, slot, hex } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const s = parseInt(slot, 10);
  if (!(s >= 0 && s <= 3)) return res.status(400).json({ error: "Slot must be 0–3" });
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) return res.status(400).json({ error: "Color must be RRGGBB hex" });
  const rgba = m[1].toUpperCase() + "FF";
  const base = String(p.url).replace(/\/+$/, "");
  try {
    let r = await fetch(base + "/printer/objects/query?print_stats&print_task_config");
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status });
    const st = (((await r.json()).result || {}).status) || {};
    const state = (st.print_stats || {}).state || "unknown";
    if (state === "printing" || state === "paused")
      return res.status(409).json({ error: "Printer is " + state + " — colors can only be changed while idle" });
    const exist = ((st.print_task_config || {}).filament_exist) || [];
    if (!exist[s]) return res.status(409).json({ error: "No filament loaded in slot T" + (s + 1) });
    // Official RFID spools are color-locked: firmware rejects the write with
    // "official filament, not configurable!" (hardware-confirmed 2026-07-09).
    // filament_edit is the authoritative writability flag — fail friendly here
    // instead of surfacing a Moonraker traceback.
    const editArr = ((st.print_task_config || {}).filament_edit) || [];
    if (editArr[s] === false)
      return res.status(409).json({ error: "T" + (s + 1) + " is an official Snapmaker RFID spool — its color comes from the tag and can't be changed" });

    const script = `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER='${s}' FILAMENT_COLOR_RGBA='${rgba}' SAVE='1'`;
    r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(script), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });

    // Read back — success means the printer itself reports the new color.
    r = await fetch(base + "/printer/objects/query?print_task_config");
    if (!r.ok) return res.status(502).json({ error: "Write sent but read-back failed: Moonraker " + r.status });
    const ptc = ((((await r.json()).result || {}).status || {}).print_task_config) || {};
    const got = (ptc.filament_color_rgba || [])[s];
    if (String(got || "").toUpperCase() !== rgba)
      return res.status(502).json({ error: "Write not confirmed — printer reports " + (got || "nothing") });
    res.json({ ok: true, slot: s, hex: "#" + m[1].toUpperCase(), heads: decodeHeads(ptc) });
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
  const p = PRINTERS[idx];
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
