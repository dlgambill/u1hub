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


// 2.42 (H3): every call to a printer is bounded. A printer that stops
// answering used to hold a push (and the file - activePushOf refuses rename
// and delete while a push is open) forever. Limits are env-tunable so the
// harness can prove them in seconds.
const PRINTER_TIMEOUT_MS = Math.max(500, Number(process.env.U1HUB_PRINTER_TIMEOUT_MS) || 10000);
const UPLOAD_IDLE_MS = Math.max(500, Number(process.env.U1HUB_UPLOAD_IDLE_MS) || 30000);
const UPLOAD_SOCKET_MS = Math.max(UPLOAD_IDLE_MS, 60000);

// fetch() with a deadline. A timeout rejects with "timed out after N s" so
// the routes' existing catch blocks report it as a plain sentence.
async function fetchWithTimeout(url, opts, ms) {
  const limit = ms || PRINTER_TIMEOUT_MS;
  try {
    return await fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(limit) });
  } catch (e) {
    if (e && (e.name === "TimeoutError" || e.name === "AbortError"))
      throw new Error("timed out after " + Math.round(limit / 1000) + " s - the printer did not answer");
    throw e;
  }
}

// 2.43 (H20): the same no-progress rule for every streamed transfer
// (printer to printer, printer to Hub library). Calls onStall once when
// job.sent has not moved for `ms` while isDone() is false. Returns a stop
// function. One helper, used everywhere a stream can stall.
function progressWatchdog(job, onStall, ms = UPLOAD_IDLE_MS, isDone = () => false) {
  let last = job.sent, moved = Date.now();
  const iv = setInterval(() => {
    if (isDone()) return;
    if (job.sent !== last) { last = job.sent; moved = Date.now(); return; }
    if (Date.now() - moved >= ms) {
      clearInterval(iv);
      onStall(new Error("transfer stalled - no data moved for " + Math.round(ms / 1000) + " s"));
    }
  }, Math.min(1000, Math.max(100, Math.floor(ms / 5))));
  return () => clearInterval(iv);
}

// Stream a file to the printer as multipart/form-data, reporting bytes sent so
// the UI can show a real upload progress bar. Resolves on the printer's 2xx.
// H3: fails (and so releases the file) when the printer stops taking bytes
// for UPLOAD_IDLE_MS while the body is still going out, or when the socket
// goes quiet for UPLOAD_SOCKET_MS at any point (including waiting for the
// printer's answer after the last byte).
function uploadWithProgress(base, fp, name, job) {
  return new Promise((resolve, reject) => {
    let settled = false, watchdog = null, fileStream = null;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (fileStream) fileStream.destroy();       // let go of the file handle
      fn(v);
    };
    resolve = (r => v => done(r, v))(resolve);
    reject = (r => e => done(r, e))(reject);
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
    // 2.44: say which of two different things happened. "stalled" is a
    // printer that stopped answering mid-transfer; a printer that never
    // accepted the connection is "could not connect" (unplugged, wrong
    // address, asleep). The hand test on 2.42.0 reported the second as the
    // first, which sends someone looking at the wrong thing.
    let connected = false;
    req.on("socket", sock => { if (sock.connecting === false) connected = true; else sock.once("connect", () => { connected = true; }); });
    req.on("response", () => { connected = true; });
    req.on("error", e => {
      if (!connected && e && /stalled/.test(e.message))
        return reject(new Error("could not connect to " + u.hostname + " - the printer did not accept the connection (unplugged, asleep, or a wrong address?)"));
      reject(e);
    });
    // Socket idle limit: nothing in or out for UPLOAD_SOCKET_MS ends it.
    req.setTimeout(UPLOAD_SOCKET_MS, () => req.destroy(new Error(connected
      ? "upload stalled - the printer stopped answering for " + Math.round(UPLOAD_SOCKET_MS / 1000) + " s"
      : "could not connect to " + u.hostname + " within " + Math.round(UPLOAD_SOCKET_MS / 1000) + " s - the printer did not accept the connection (unplugged, asleep, or a wrong address?)")));
    req.write(pre); job.sent += pre.length;
    fileStream = fs.createReadStream(fp);
    const counter = new Transform({ transform(chunk, _e, cb) { job.sent += chunk.length; cb(null, chunk); } });
    fileStream.on("error", reject);
    counter.on("error", reject);
    // Progress watchdog: while the body is still going out, no new bytes
    // accepted for UPLOAD_IDLE_MS means the printer has stopped reading.
    let bodyDone = false, lastSent = job.sent, lastMove = Date.now();
    watchdog = setInterval(() => {
      if (bodyDone) return;
      if (job.sent !== lastSent) { lastSent = job.sent; lastMove = Date.now(); return; }
      if (Date.now() - lastMove >= UPLOAD_IDLE_MS)
        req.destroy(new Error(connected
          ? "upload stalled - the printer took no data for " + Math.round(UPLOAD_IDLE_MS / 1000) + " s"
          : "could not connect to " + u.hostname + " - the printer did not accept the connection (unplugged, asleep, or a wrong address?)"));
    }, Math.min(1000, Math.max(100, Math.floor(UPLOAD_IDLE_MS / 5))));
    counter.on("data", chunk => { if (!req.write(chunk)) { counter.pause(); req.once("drain", () => counter.resume()); } });
    counter.on("end", () => { bodyDone = true; req.write(post); job.sent += post.length; req.end(); });
    fileStream.pipe(counter);
  });
}


// Count the manual filament-change / pause commands in a gcode file, streamed
// (files run 200-400 MB and must never be read whole). Only called when a
// mapping puts two DIFFERENT colors on one head - the one case where a pause
// is the explanation. M600 is the slicer's filament change; PAUSE is the
// Klipper macro Orca's custom templates use; M0/M1/M226 are the classic
// program-stop forms. A leading ';' is a comment and does not count.
function countPauses(fp) {
  return new Promise(resolve => {
    let n = 0;
    const rl = require("readline").createInterface({ input: fs.createReadStream(fp) });
    rl.on("line", l => { if (/^\s*(M600|M0|M1|M226|PAUSE)\b/i.test(l)) n++; });
    rl.on("close", () => resolve(n));
    rl.on("error", () => resolve(n));
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
app.get("/api/filament-memory", async (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile(String(req.query.file || ""), t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  let hash;
  try { hash = await hub.fileContentHashAsync(fp); }   // v2.26.2: off the event loop
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
      const hexByIdx = ((await hub.paletteForFileAsync(path.basename(fp), t)) || {}).hexByIdx || {};
      const norm = x => String(x == null ? "" : x).trim().replace(/^#/, "").slice(0, 6).toUpperCase();
      for (const [head, ts] of shared) {
        const hexes = ts.map(x => norm(hexByIdx[x]));
        if (hexes.some(h => !h))                                  // unknown color — can't prove it's safe
          return res.status(400).json({ error: "Two colors are mapped to T" + (Number(head) + 1) + " and the file's colors for them couldn't be read — give each its own head." });
        if (new Set(hexes).size !== 1) {
          // v2.23.1 (GitHub #3): more colors than heads is a real workflow -
          // a 5-color file with an M600/PAUSE where you swap the roll on one
          // head. Two DIFFERENT colors on a head is allowed exactly when the
          // file carries a pause to do the swap at, and even then only after
          // the person confirms (409 + force, the class-guard pattern below).
          // Without a pause the two colors would simply print wrong, so that
          // stays a hard reject - now with the pause named as the way out.
          const label = "T" + (Number(head) + 1) + " is mapped to different colors (" + hexes.map(h => "#" + h).join(" and ") + ")";
          const pauses = await countPauses(fp);
          if (pauses > 0 && force) { hublog("info", "print: " + label + " — allowed on confirm, file has " + pauses + " pause(s)"); continue; }
          if (pauses > 0)
            return res.status(409).json({ classWarning: true,
              error: label + ". The file has " + pauses + " pause" + (pauses === 1 ? "" : "s") + " (M600/PAUSE), so this works if you swap the roll on T" + (Number(head) + 1) + " when the printer stops. Send anyway?" });
          return res.status(400).json({ error: label + " — one head prints one color, so give each its own head. If you meant to swap rolls mid-print, add a filament-change pause (M600 or PAUSE) to the gcode at the swap and the Hub will let it through." });
        }
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
    const pal = await hub.paletteForFileAsync(path.basename(fp), t);
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
    const r = await fetchWithTimeout(base + "/printer/gcode/script?script=" + encodeURIComponent(script), { method: "POST" });
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
        // v2.41 unload-for-next. The U1 firmware already unloads a head at the
        // end of a print when print_task_config.end_unload_filament[head] is
        // true (its PRINT_END -> SM_PRINT_END_AUTO_UNLOAD_FILAMENT; soft
        // filament like TPU is skipped by the firmware itself). The flags can
        // only be set while the printer is NOT printing and the firmware
        // resets them to all-false when a print finishes, so they are decided
        // here, per print, right before it starts. Dispatch says which heads
        // the next job planned on this printer will not reuse; off, unknown
        // or failing all mean [0,0,0,0] - an unload nobody asked for costs a
        // cut and a reload, a missed one only costs what it cost before.
        let unload = [0, 0, 0, 0];
        try {
          const decide = hub.CAPS_PROVIDED && hub.CAPS_PROVIDED.get("dispatch.unloadPlan");
          if (decide) {
            const hexByIdx = ((await hub.paletteForFileAsync(name, t)) || {}).hexByIdx || {};
            const headHex = {};                        // physical head -> the one color it prints, or null if two
            for (const tool of tools) {
              const h = map[tool], hx = String(hexByIdx[tool] || "").replace(/^#/, "").slice(0, 6).toUpperCase();
              headHex[h] = (h in headHex && headHex[h] !== hx) ? null : (hx || null);
            }
            const d = await decide(Number(printer), name, headHex);
            if (d && Array.isArray(d.unload)) {
              unload = d.unload.slice(0, 4).map(x => (x ? 1 : 0));
              while (unload.length < 4) unload.push(0);
              if (unload.some(Boolean))
                hublog("info", "print: " + p.name + " will unload " + unload.map((u, i) => u ? "T" + (i + 1) : null).filter(Boolean).join(", ") +
                  " after " + name + (d.next ? " (next here: " + d.next.file + ")" : ""));
            }
          }
        } catch (e) { hublog("warn", "print: unload-for-next skipped - " + e.message); unload = [0, 0, 0, 0]; }
        lines.push("SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0 END_UNLOAD_FILAMENT=[" + unload.join(",") + "]");
        job.unload = unload;
        await gcode(lines.join("\n"));
      }
      if (start) {
        job.phase = "starting"; await gcode(`SDCARD_PRINT_FILE FILENAME="${name}"`); dequeueFile(name, t.slug);
        // S5 (2.44): Dispatch holds this copy in flight until it sees it printing.
        try { const started = hub.CAPS_PROVIDED && hub.CAPS_PROVIDED.get("dispatch.printStarted"); if (started) started(Number(printer), name, t.slug); } catch {}
      }
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
    const r = await fetchWithTimeout(base + "/printer/gcode/script?script=" + encodeURIComponent(cmd), { method: "POST" });
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
    const r = await fetchWithTimeout(base + "/printer/objects/query?exclude_object", { method: "GET" });
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
    const r = await fetchWithTimeout(base + "/printer/gcode/script?script=" + encodeURIComponent(`EXCLUDE_OBJECT NAME=${name}`), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, excluded: name });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

Object.assign(hub, { JOBS, newJobId, fetchWithTimeout, progressWatchdog, UPLOAD_SOCKET_MS });
};
