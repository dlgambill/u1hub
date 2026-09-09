// core/print.js — the print pipeline: color rewrite, upload, /api/print, print control, exclude-object
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Transform } = require("stream");

module.exports = function (hub) {
const { BASE_DIR, app, dequeueFile, detectCaps, fileContentHash, fmem, hublog, paletteForFile, reqTypeOf, safeFile } = hub;


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


// v2.10 — filament memory recall. Hashes the local file's CONTENT and looks
// up the last completed loadout for those bytes. Rename-proof: the same file
// under any name (or in another type's folder after a manual move) still
// matches. Spool details are re-read from the CURRENT bindings so the UI shows
// live names/colors; a spool forgotten since is returned from the stored
// snapshot with missing:true so the client can grey it out.
app.get("/api/filament-memory", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile(String(req.query.file || ""), t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  let hash;
  try { hash = fileContentHash(fp); }
  catch (e) { return res.status(500).json({ error: "Could not hash file: " + e.message }); }
  const rec = fmem()[hash];
  if (!rec) return res.json({ known: false, hash });
  let cur = {};
  try { cur = (JSON.parse(fs.readFileSync(path.join(BASE_DIR, "spools.json"), "utf8")) || {}).spools || {}; } catch {}
  const spools = (rec.spools || []).map(s => {
    const live = cur[s.spool_id];
    return live
      ? { ...s, hex: live.hex || s.hex, color_name: live.color_name || s.color_name,
          brand: live.brand || s.brand, material_variant: live.material_variant || s.material_variant, missing: false }
      : { ...s, missing: true };
  });
  res.json({ known: true, hash, file: rec.file, ts: rec.ts, spools });
});


app.post("/api/print", async (req, res) => {
  const { file, printer, start, map, force } = req.body || {};
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile(file, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  const p = hub.PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  // Structural cross-class block: the switcher already hides the other fleet,
  // but the server refuses too — a stale page or hand-crafted request can't
  // send a U1 file to a Sovol (or vice versa).
  if ((p.type || "u1") !== t.slug)
    return res.status(400).json({ error: p.name + " belongs to a different printer type ('" + (p.type || "u1") + "') — switch to that type to send this file." });

  // map is { logicalToolIndex: physicalHeadIndex }. Two tools may legitimately
  // share a head when the FILE gives them the same color: slicers that can't
  // merge extruders (Orca, unlike Bambu/Snorca) leave you recoloring one tool to
  // match another, and the resulting 4-tool file only needs 3 physical rolls.
  // Refusing that blocked a print that would have been correct (field-found
  // 2026-08-24). Genuinely different colors on one head still print wrong, so
  // that stays a hard reject — the test is the palette hex, not the head count.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
    const byHead = new Map();
    for (const tool of tools) {
      const h = map[tool];
      if (!byHead.has(h)) byHead.set(h, []);
      byHead.get(h).push(tool);
    }
    const shared = [...byHead.entries()].filter(([, ts]) => ts.length > 1);
    if (shared.length) {
      const hexByIdx = (paletteForFile(path.basename(fp), t) || {}).hexByIdx || {};
      const norm = x => String(x == null ? "" : x).trim().replace(/^#/, "").slice(0, 6).toUpperCase();
      for (const [head, ts] of shared) {
        const hexes = ts.map(x => norm(hexByIdx[x]));
        if (hexes.some(h => !h))                                  // unknown color — can't prove it's safe
          return res.status(400).json({ error: "Two colors are mapped to T" + (Number(head) + 1) + " and the file's colors for them couldn't be read — give each its own head." });
        if (new Set(hexes).size !== 1)
          return res.status(400).json({ error: "T" + (Number(head) + 1) + " is mapped to different colors (" + hexes.map(h => "#" + h).join(" and ") + ") — one head prints one color, so give each its own head." });
      }
      hublog("info", "print: " + shared.map(([h, ts]) => ts.length + " same-color tools → T" + (Number(h) + 1)).join(", "));
    }
  }

  // Send-time class guard (quiet backstop). Mostly redundant once the switcher
  // hides cross-class targets, but cheap: sniff the gcode's palette against the
  // target's DETECTED capabilities and catch anything that slipped through
  // (e.g. a file dropped into the wrong type's folder by hand).
  //   * multi-color / toolchange / FS gcode → single-extruder instance: WARN
  //     (409 until the client confirms with force:true).
  //   * single-color job → multi-head U1-style instance: soft note only.
  let classNote = null;
  try {
    const pal = paletteForFile(path.basename(fp), t);
    const caps = await detectCaps(Number(printer));
    if (pal && caps) {
      const multiJob = pal.isFS || pal.usedCount > 1 || (pal.anyTC && pal.usedCount !== 1);
      if (multiJob && caps.heads === 1 && !force) {
        hublog("info", "class-guard: blocked '" + path.basename(fp) + "' → " + p.name + " (multi-color job, single extruder)");
        return res.status(409).json({
          classWarning: true,
          error: "'" + path.basename(fp) + "' looks like a multi-color job (" +
            (pal.isFS ? "Full Spectrum" : pal.usedCount + " colors" + (pal.anyTC ? ", toolchanges" : "")) +
            ") but " + p.name + " reports a single extruder. It will likely fail or print wrong. Send anyway?"
        });
      }
      if (!multiJob && caps.multiColor) classNote = "Single-color job — any one loaded head on " + p.name + " can print it.";
    }
  } catch {} // guard is advisory — never let sniffing break a legitimate send

  const base = String(p.url).replace(/\/+$/, "");
  const name = path.basename(fp);
  const gcode = async script => {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(script), { method: "POST" });
    if (!r.ok) throw new Error("gcode (" + r.status + "): " + (await r.text()).slice(0, 200));
  };

  // Kick the work off in the background and hand the client a job id to poll.
  const jobId = newJobId();
  const job = { file: name, phase: "upload", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
  JOBS.set(jobId, job);
  res.json({ jobId, note: classNote });

  (async () => {
    try {
      await uploadWithProgress(base, fp, name, job);     // 1) upload (with progress)
      hub.invalidatePrinterFiles?.();                     // new file on that printer — drop the on-board snapshot
      if (tools.length) {                                 // 2) toolhead mapping macros
        job.phase = "mapping";
        const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
        // USED_EXTRUDERS is a set of PHYSICAL heads: when two same-color tools
        // share one head it must be listed once, not "3,3".
        lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + [...new Set(tools.map(t => map[t]))].join(","));
        lines.push("SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
        await gcode(lines.join("\n"));
      }
      if (start) { job.phase = "starting"; await gcode(`SDCARD_PRINT_FILE FILENAME="${name}"`); dequeueFile(name, t.slug); }
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
  const p = hub.PRINTERS[printer];
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
  const p = hub.PRINTERS[req.query.printer];
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
  const p = hub.PRINTERS[printer];
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

Object.assign(hub, { JOBS, newJobId });
};
