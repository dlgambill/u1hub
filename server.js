// server.js — U1 Print Hub  ·  v2.5.0
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "2.9.0";

const express = require("express");
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const { Transform } = require("stream");
const { parseGcodeMap } = require("./parser");

// ---- Ring-buffer logger (v2.9, beta diagnostics) ----------------------------
// Keeps the last ~500 log lines in memory so /api/diagnostics can hand a beta
// tester's GitHub issue real evidence (capability detections, class-guard
// hits, migrations, errors) without the Hub ever writing a log file or
// phoning home. console.warn/error are mirrored in so uncaught noise is
// captured too; hublog() is the deliberate hook at decision points.
const HUBLOG = [];
const HUBLOG_MAX = 500;
function hublog(level, msg) {
  HUBLOG.push({ t: Date.now(), level, msg: String(msg).slice(0, 500) });
  if (HUBLOG.length > HUBLOG_MAX) HUBLOG.splice(0, HUBLOG.length - HUBLOG_MAX);
}
for (const lvl of ["warn", "error"]) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { try { hublog(lvl, a.map(x => (x && x.stack) || String(x)).join(" ")); } catch {} orig(...a); };
}

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
const IS_PKG = typeof process.pkg !== "undefined";
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const ASSET_DIR = __dirname;

const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [], tip: { label: "Buy me a beer 🍺", url: "https://venmo.com/u/dgambill" } };

// ---- Printer TYPES (v2.9) ---------------------------------------------------
// A *type* owns a folder + accent + switcher tab; *instances* (physical
// printers) belong to a type and share its folder/accent. Type name is
// organizational ONLY — it never decides which features render. Feature-gating
// stays on capability detection (Klipper objects, see CAPS below). Two
// orthogonal layers, both present: type drives folder + accent + switcher;
// capability detection drives UI.
//
// Folder model (constrained by design):
//   * The built-in U1 type is GRANDFATHERED: locked to the existing flat gcode
//     directory at its current path. Nothing on disk moves on upgrade.
//   * Every NEW type gets an auto-created subfolder <base>/<slug>/. The user
//     names the type; the Hub makes the folder. Nobody browses to an arbitrary
//     path, so the traversal surface stays exactly what safeFile covers today.
//   * The type→folder binding is persisted in config.json and re-validated on
//     every load, so the lock survives restarts and hand-edits can't overlap.
// Reuse-lock rules: collision → rejected; parent/child nesting → rejected;
// unbind/delete → folder freed, gcode files PRESERVED on disk (never deleted);
// folder missing at boot → per-type warning, no crash, no silent recreate.
const U1_ACCENT = "#FFB200"; // today's exact accent — existing users see zero change
const ACCENT_PRESETS = ["#5B9BF0", "#46C18C", "#C77DFF", "#FF7A59", "#3EC9C9", "#E0568C", "#A8C64E", "#F0C33C"];
const BUILTIN_U1 = { slug: "u1", label: "U1", accent: U1_ACCENT, builtin: true };

function slugify(label) {
  return String(label || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// Live config — editable from the Settings page, no restart needed.
let CFG, FOLDER, PRINTERS, TYPES;
let TYPE_WARNINGS = {};   // slug -> human-readable boot/validation warning
function typeBySlug(slug) { return (TYPES || []).find(t => t.slug === slug); }
// Immutable slug → directory. Renaming a display label must never move the
// folder or strand queue entries, so the path derives from the slug alone.
function typeFolder(t) { return t.builtin ? FOLDER : path.resolve(FOLDER, t.folder || t.slug); }

// Validate the persisted type list: dedupe slugs, pin the grandfathered U1,
// enforce the reuse-lock rules against hand-edited configs, surface (don't
// crash on, don't silently fix) folders that are missing at startup.
function validateTypes(list) {
  TYPE_WARNINGS = {};
  const out = [];
  const seen = new Set();
  let u1 = (list || []).find(t => t && t.slug === "u1");
  u1 = { ...BUILTIN_U1, label: (u1 && u1.label) || "U1", accent: (u1 && u1.accent) || U1_ACCENT };
  out.push(u1); seen.add("u1");
  for (const t of (list || [])) {
    if (!t || !t.slug || t.slug === "u1") continue;
    const slug = slugify(t.slug);
    if (!slug || seen.has(slug)) { if (slug) TYPE_WARNINGS[slug] = "Duplicate type slug — kept the first entry."; continue; }
    const rec = { slug, label: String(t.label || slug), accent: String(t.accent || ACCENT_PRESETS[out.length % ACCENT_PRESETS.length]), folder: slug };
    const dir = typeFolder(rec);
    // Nesting guard: a type folder must be a DIRECT child of the base folder —
    // never the base itself, never outside it, never inside another type's dir.
    // Auto-created folders always satisfy this; hand-edited configs might not.
    if (dir === FOLDER || path.dirname(dir) !== FOLDER) {
      TYPE_WARNINGS[slug] = "Folder for type '" + rec.label + "' is not a direct subfolder of the gcode base — type disabled to prevent file bleed.";
      continue;
    }
    if (!fs.existsSync(dir)) {
      // Missing at startup: warn, keep the binding, do NOT silently recreate.
      TYPE_WARNINGS[slug] = "Bound folder is missing on disk (" + dir + "). Files are NOT touched — restore the folder or delete the type.";
    }
    out.push(rec); seen.add(slug);
  }
  return out;
}

function saveConfigFile() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch {}
}

function loadConfig() {
  try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { CFG = { ...DEFAULT_CFG }; }
  FOLDER = path.resolve(BASE_DIR, CFG.gcodeFolder || "./gcode");
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  try { fs.mkdirSync(FOLDER, { recursive: true }); } catch {}   // base dir: today's behavior, unchanged
  // v2.8.1 → v2.9 migration: register the built-in U1 type and tag existing
  // printers as U1 instances. No files move — U1 stays flat in the base dir.
  let migrated = false;
  if (!Array.isArray(CFG.types)) { CFG.types = [{ ...BUILTIN_U1 }]; migrated = true; }
  TYPES = validateTypes(CFG.types);
  CFG.types = TYPES;
  for (const p of PRINTERS) {
    if (!p.type || !typeBySlug(p.type)) { p.type = "u1"; migrated = true; }
  }
  if (migrated) saveConfigFile();
  CAPS.clear();            // printer list may have changed — re-detect capabilities
  if (FARM_READY) farmWsRestart(); // reconnect sockets to the new printer list
  // (FARM_READY is a hoisted var — falsy during the initial top-of-file
  // loadConfig(), so sockets first connect once the farm section is defined)
}
// ---- Capability detection (the OTHER layer — drives UI, not folders) --------
// Queried from Klipper's own object list per printer, cached until the config
// changes. print_task_config present = Snapmaker U1-style 4-head machine with
// the color/RFID API; absent = generic Klipper/Moonraker (e.g. Sovol SV06
// Plus ACE on stock Moonraker :7125) — heads counted from extruder objects.
const CAPS = new Map(); // printer idx -> { multiColor, heads } | null while unknown
async function detectCaps(idx) {
  const p = PRINTERS[idx];
  if (!p) return null;
  const hit = CAPS.get(idx);
  if (hit) return hit;
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/printer/objects/list", { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const objects = (((await r.json()).result) || {}).objects || [];
    const multiColor = objects.includes("print_task_config");
    const heads = multiColor ? 4 : Math.max(1, objects.filter(o => /^extruder\d*$/.test(o)).length);
    const caps = { multiColor, heads };
    CAPS.set(idx, caps);
    hublog("info", "caps[" + (p.name || idx) + "]: multiColor=" + multiColor + " heads=" + heads + " (objects: " + objects.length + ")");
    return caps;
  } catch (e) { hublog("warn", "caps[" + (p.name || idx) + "]: detection failed — " + (e && e.message || e)); return null; }
}
loadConfig();
const PORT = CFG.port || 4545;

// --- last-printed tracking --------------------------------------------------
// Stamps printlog.json (basename -> epoch ms) when a printer transitions INTO
// "printing". A 15s poll watches each printer's state; we only record a genuine
// new start — skipping boot-mid-print (no prior state observed) and
// resume-from-pause (paused -> printing is not a new print).
const PRINTLOG_PATH = path.join(BASE_DIR, "printlog.json");
// v2.9: printlog is namespaced per type slug — { "u1": { basename: ms }, ... }.
// A flat v2.8.x map (basename -> ms) is wrapped under "u1" on first load
// (existing entries were all U1 prints by definition).
function loadPrintLog() {
  let raw; try { raw = JSON.parse(fs.readFileSync(PRINTLOG_PATH, "utf8")); } catch { return {}; }
  if (!raw || typeof raw !== "object") return {};
  const flat = Object.values(raw).some(v => typeof v === "number");
  return flat ? { u1: raw } : raw;
}
function savePrintLog() { try { fs.writeFileSync(PRINTLOG_PATH, JSON.stringify(PRINTLOG, null, 2)); } catch {} }
let PRINTLOG = loadPrintLog();
function plogOf(slug) { return PRINTLOG[slug] || (PRINTLOG[slug] = {}); }

// --- print queue --------------------------------------------------------------
// A single shared "up next" list (queue.json, array of {id, file, added}).
// Reference-only by design: the Hub never auto-starts queued jobs — the U1
// needs its plate cleared between prints, so starting is always a human tap.
// When a print is STARTED for a file that's in the queue, the first matching
// entry is removed automatically (upload-without-start leaves the queue alone).
const QUEUE_PATH = path.join(BASE_DIR, "queue.json");
// v2.9: entries carry a type slug ({id, file, added, type}). Pre-2.9 entries
// (no type field) are tagged "u1" on first load — they were all U1 jobs.
function loadQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    return Array.isArray(q) ? q.map(e => (e && !e.type ? { ...e, type: "u1" } : e)) : [];
  } catch { return []; }
}
function saveQueue() { try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(QUEUE, null, 2)); } catch {} }
let QUEUE = loadQueue();
function dequeueFile(name, slug) {
  const i = QUEUE.findIndex(e => e.file === name && (!slug || e.type === slug));
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
      if (base) { plogOf(PRINTERS[i].type || "u1")[base] = Date.now(); savePrintLog(); }
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
// Remote access — Hub-managed Cloudflare tunnel (see tunnel.js design notes).
// Mounted after the gate so every /api/tunnel/* route requires login.
require("./tunnel.js")(app, express, BASE_DIR, PORT);
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
// QR spool labels (v2.9): printable sheet, same packaged-binary treatment.
app.get("/labels.html", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "labels.html"), "utf8")); }
  catch (e) { res.status(500).send("labels.html not found"); }
});
require("./fs-colors.js")(app, express);
// RFID / spool identity (v2.9): hub-side tag scanning → spool_id → filament
// identity, backed by the bundled FilamentColors.xyz snapshot. Printers never
// read tags for this feature; see rfid.js design notes.
require("./rfid.js")(app, express, BASE_DIR, ASSET_DIR, {
  getPrinters: () => PRINTERS,
  // v2.9 loadout: slot-range validation wants detected head counts (Rule-of-
  // capability, not type labels). null while unknown — validation stays lenient.
  getCaps: (idx) => detectCaps(idx),
  log: hublog
});

// Resolve a requested filename safely INSIDE a type's bound folder (no
// traversal). Same basename-only discipline as always — the type only selects
// WHICH locked folder, so safeFile coverage is unchanged in kind.
function safeFile(name, t) {
  if (!name) return null;
  const dir = typeFolder(t || typeBySlug("u1"));
  const p = path.resolve(dir, path.basename(name));
  return p.startsWith(dir + path.sep) || path.dirname(p) === dir ? p : null;
}
// Resolve the ?type= / body.type param to a validated type record (default U1).
function reqTypeOf(req) {
  const slug = String((req.query && req.query.type) || ((req.body || {}).type) || "").trim();
  if (!slug) return typeBySlug("u1") || TYPES[0];
  return typeBySlug(slug) || null;
}

// ---- Types API ---------------------------------------------------------------
app.get("/api/types", (req, res) => {
  res.json({
    types: TYPES.map(t => ({
      slug: t.slug, label: t.label, accent: t.accent, builtin: !!t.builtin,
      // v2.9 ships multi-printer-type as BETA: harness-verified against mock
      // printers, awaiting broad real-hardware verification (Rule #1 by proxy
      // — beta testers attach /api/diagnostics bundles to GitHub issues).
      beta: !t.builtin,
      folder: typeFolder(t),
      printerCount: PRINTERS.filter(p => (p.type || "u1") === t.slug).length,
      warning: TYPE_WARNINGS[t.slug] || null
    }))
  });
});

// "Add printer type" — deliberately separate from "Add printer": the user only
// names it; the Hub generates the immutable slug, creates <base>/<slug>/,
// assigns the next preset accent, and the switcher tab appears. Done once.
app.post("/api/types", (req, res) => {
  const label = String((req.body || {}).label || "").trim();
  if (!label) return res.status(400).json({ error: "Type needs a name" });
  const slug = slugify(label);
  if (!slug) return res.status(400).json({ error: "Name must contain letters or numbers" });
  if (typeBySlug(slug)) return res.status(409).json({ error: "A type with slug '" + slug + "' already exists — its folder is locked to that type. Pick a different name." });
  const rec = { slug, label, accent: String((req.body || {}).accent || "").trim() || ACCENT_PRESETS[(TYPES.length - 1) % ACCENT_PRESETS.length], folder: slug };
  const dir = typeFolder(rec);
  // Reuse-lock: refuse a folder that already belongs to (or nests with) another
  // type. Structural with auto-subfolders, but hand-edited configs exist.
  if (dir === FOLDER || path.dirname(dir) !== FOLDER)
    return res.status(400).json({ error: "Type folder must be a direct subfolder of the gcode base" });
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: "Could not create folder " + dir + " — " + e.message }); }
  TYPES.push(rec); CFG.types = TYPES; saveConfigFile();
  res.json({ ok: true, type: { ...rec, folder: dir } });
});

// Edit display label / accent. The slug (and therefore the folder) is
// IMMUTABLE — renaming the label never moves files or strands queue entries.
app.post("/api/types/update", (req, res) => {
  const t = typeBySlug(String((req.body || {}).slug || ""));
  if (!t) return res.status(404).json({ error: "Unknown type" });
  const b = req.body || {};
  if (typeof b.label === "string" && b.label.trim()) t.label = b.label.trim();
  if (typeof b.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(b.accent.trim())) t.accent = b.accent.trim().toUpperCase();
  CFG.types = TYPES; saveConfigFile();
  res.json({ ok: true, type: t });
});

// Delete/unbind a type: the folder is freed for reuse but gcode files are
// PRESERVED on disk — the Hub never auto-deletes a user's prints.
app.post("/api/types/delete", (req, res) => {
  const slug = String((req.body || {}).slug || "");
  const t = typeBySlug(slug);
  if (!t) return res.status(404).json({ error: "Unknown type" });
  if (t.builtin) return res.status(400).json({ error: "The built-in U1 type can't be deleted" });
  const inUse = PRINTERS.filter(p => (p.type || "u1") === slug).length;
  if (inUse) return res.status(409).json({ error: inUse + " printer(s) still belong to '" + t.label + "' — reassign or remove them first." });
  TYPES = TYPES.filter(x => x.slug !== slug); CFG.types = TYPES;
  const qBefore = QUEUE.length;
  QUEUE = QUEUE.filter(e => e.type !== slug);
  if (QUEUE.length !== qBefore) saveQueue();
  delete TYPE_WARNINGS[slug];
  saveConfigFile();
  res.json({ ok: true, note: "Folder and gcode files were preserved on disk." });
});

app.get("/api/printers", (req, res) => {
  res.json(PRINTERS.map((p, i) => ({ id: i, name: p.name, type: p.type || "u1" })));
});

app.get("/api/files", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const dir = typeFolder(t);
  const plog = plogOf(t.slug);
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(gcode|gco|g)$/i.test(f))
      .map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, lastPrinted: plog[f] || null };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ folder: dir, type: t.slug, files });
  } catch (e) {
    res.status(500).json({ error: "Cannot read folder " + dir + " — " + e.message + (TYPE_WARNINGS[t.slug] ? " · " + TYPE_WARNINGS[t.slug] : "") });
  }
});

// --- onboard printer files (read-only) ----------------------------------------
// Lists gcode stored ON a printer via Moonraker GET /server/files/list?root=gcodes.
// Response shape hardware-verified 2026-07-19 on 192.168.12.88 (73 files):
//   { result: [ { path, modified (epoch seconds, float), size, permissions } ] }
// `modified` is converted to ms (mtime) to match /api/files, so the unified
// library view can sort both sources with a single comparator. Strictly
// read-only: management ops (move/delete/rename — endpoints verified same day:
// upload 201 / move 200 / delete 200) come in a later slice and will honor
// each file's `permissions` flag rather than assuming everything is writable.
async function listOnboard(p) {
  const base = String(p.url).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(base + "/server/files/list?root=gcodes", { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const arr = ((await r.json()).result) || [];
    return arr
      .filter(f => /\.(gcode|gco|g)$/i.test(f.path || ""))
      .map(f => ({
        name: f.path,                       // may include subfolder, e.g. "sub/x.gcode"
        size: f.size || 0,
        mtime: (f.modified || 0) * 1000,    // ms, same unit as /api/files
        permissions: f.permissions || ""
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } finally { clearTimeout(to); }
}

// GET /api/printer-files            -> all printers, queried in parallel
// GET /api/printer-files?printer=N  -> just printer N (same id as /api/printers)
// A printer that can't be reached reports online:false + error instead of
// failing the whole response — offline machines must not blank the fleet view.
app.get("/api/printer-files", async (req, res) => {
  const want = req.query.printer;
  const slug = String(req.query.type || "");   // optional: only that type's instances
  let targets = (want === undefined)
    ? PRINTERS.map((p, i) => ({ p, i }))
    : (PRINTERS[want] ? [{ p: PRINTERS[want], i: Number(want) }] : null);
  if (!targets) return res.status(400).json({ error: "Unknown printer " + want });
  if (slug) targets = targets.filter(({ p }) => (p.type || "u1") === slug);
  const out = await Promise.all(targets.map(async ({ p, i }) => {
    try { return { id: i, name: p.name, online: true, files: await listOnboard(p) }; }
    catch (e) { return { id: i, name: p.name, online: false, error: String(e.message || e), files: [] }; }
  }));
  res.json({ printers: out });
});

// --- library file management (local FOLDER only) -------------------------------
// Delete / rename for the Hub's server library. Strictly local fs — nothing in
// this block talks to a printer. Guards:
//   * safeFile() on every name (basenames only, no traversal)
//   * DELETE refuses while the file is queued (queue.json would point at nothing)
//   * both refuse while an active push job is streaming the file to a printer
//     (jobs carry their filename for exactly this check)
//   * rename never silently overwrites an existing target
// Rename MIGRATES queue entries and printlog history so "up next" and "last
// printed" follow the file to its new name; delete removes the printlog entry
// so a future file reusing the name doesn't inherit stale history.
function activePushOf(name) {
  for (const j of JOBS.values()) if (!j.done && j.file === name) return true;
  return false;
}

app.post("/api/files/delete", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const name = path.basename(String((req.body || {}).name || ""));
  const fp = safeFile(name, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found: " + name });
  if (QUEUE.some(q => q.file === name && q.type === t.slug))
    return res.status(409).json({ error: "'" + name + "' is in the print queue — remove it from the queue first." });
  if (activePushOf(name))
    return res.status(409).json({ error: "'" + name + "' is being sent to a printer right now — wait for the upload to finish." });
  try { fs.unlinkSync(fp); }
  catch (e) { return res.status(500).json({ error: "Delete failed: " + e.message }); }
  const plog = plogOf(t.slug);
  if (plog[name] !== undefined) { delete plog[name]; savePrintLog(); }
  res.json({ ok: true, deleted: name });
});

app.post("/api/files/rename", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const name = path.basename(String((req.body || {}).name || ""));
  let newName = path.basename(String((req.body || {}).newName || "").trim());
  const fp = safeFile(name, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found: " + name });
  if (!newName) return res.status(400).json({ error: "New name is empty" });
  if (!/\.(gcode|gco|g)$/i.test(newName)) newName += ".gcode"; // bare name -> .gcode
  const np = safeFile(newName, t);
  if (!np) return res.status(400).json({ error: "Bad new name" });
  if (np === fp) return res.json({ ok: true, renamed: name, to: newName }); // exact no-op
  // Case-only renames (foo -> Foo) are legal on Windows even though
  // existsSync(target) reports true on its case-insensitive filesystem.
  const caseOnly = np.toLowerCase() === fp.toLowerCase();
  if (!caseOnly && fs.existsSync(np))
    return res.status(409).json({ error: "'" + newName + "' already exists — pick a different name." });
  if (activePushOf(name))
    return res.status(409).json({ error: "'" + name + "' is being sent to a printer right now — wait for the upload to finish." });
  try { fs.renameSync(fp, np); }
  catch (e) { return res.status(500).json({ error: "Rename failed: " + e.message }); }
  let queueTouched = false;
  for (const q of QUEUE) if (q.file === name && q.type === t.slug) { q.file = newName; queueTouched = true; }
  if (queueTouched) saveQueue();
  const plog = plogOf(t.slug);
  if (plog[name] !== undefined) { plog[newName] = plog[name]; delete plog[name]; savePrintLog(); }
  res.json({ ok: true, renamed: name, to: newName, queueUpdated: queueTouched });
});

// --- printer-side file management ----------------------------------------------
// Delete / rename for files stored ON a printer, via the Moonraker endpoints
// hardware-verified 2026-07-19 on 192.168.12.88 (upload 201 / move 200 /
// delete 200). Guards, in order:
//   * ACTIVE-PRINT HARD BLOCK — a live print_stats query per operation; if the
//     target is the file being printed (or paused mid-print), refuse. Never
//     from cache: staleness here could kill a running print's file.
//   * permissions — the printer's own listing says whether a file is writable;
//     anything without "w" is refused before we ever hit the endpoint.
//   * rename never overwrites an existing target (Moonraker's behavior on a
//     dest collision is NOT hardware-verified, so the Hub refuses on its own).
//   * paths are relative to the gcodes root; ".." and absolute paths rejected;
//     each segment URL-encoded (fleet filenames contain spaces + Unicode).
function cleanRel(name) {
  const s = String(name || "").replace(/\\/g, "/").trim();
  if (!s || s.startsWith("/") || s.split("/").some(seg => seg === ".." || seg === "." || seg === "")) return null;
  return s;
}
function encPath(rel) { return rel.split("/").map(encodeURIComponent).join("/"); }
async function queryPrintStats(base) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(base + "/printer/objects/query?print_stats", { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const ps = ((((await r.json()).result) || {}).status || {}).print_stats || {};
    return { state: ps.state || "unknown", filename: ps.filename || "" };
  } finally { clearTimeout(to); }
}
// Shared preamble for both ops: resolves printer, sanitizes the name, runs the
// active-print block, and confirms existence + writability from a fresh listing.
// Returns { p, base, name, files } or replies with the error itself and returns null.
async function printerFileOpGuard(req, res) {
  const p = PRINTERS[(req.body || {}).printer];
  if (!p) { res.status(400).json({ error: "Unknown printer" }); return null; }
  const name = cleanRel((req.body || {}).name);
  if (!name) { res.status(400).json({ error: "Bad file name" }); return null; }
  const base = String(p.url).replace(/\/+$/, "");
  const ps = await queryPrintStats(base);
  if ((ps.state === "printing" || ps.state === "paused") && ps.filename === name) {
    res.status(409).json({ error: "REFUSED: '" + name + "' is the ACTIVE print on " + p.name + " (state: " + ps.state + "). The Hub will not touch a file that is printing." });
    return null;
  }
  const files = await listOnboard(p);
  const f = files.find(x => x.name === name);
  if (!f) { res.status(404).json({ error: "'" + name + "' not found on " + p.name }); return null; }
  if (f.permissions && !f.permissions.includes("w")) {
    res.status(403).json({ error: "'" + name + "' is read-only on " + p.name + " (permissions: '" + f.permissions + "')" });
    return null;
  }
  return { p, base, name, files };
}

app.post("/api/printer-files/delete", async (req, res) => {
  try {
    const g = await printerFileOpGuard(req, res);
    if (!g) return;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(g.base + "/server/files/gcodes/" + encPath(g.name), { method: "DELETE", signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return res.status(502).json({ error: g.p.name + " refused delete: HTTP " + r.status + " " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, printer: g.p.name, deleted: g.name });
  } catch (e) {
    res.status(502).json({ error: "Printer unreachable or errored: " + String(e.message || e) });
  }
});

app.post("/api/printer-files/rename", async (req, res) => {
  try {
    const g = await printerFileOpGuard(req, res);
    if (!g) return;
    let newName = cleanRel((req.body || {}).newName);
    if (!newName) return res.status(400).json({ error: "Bad new name" });
    if (!/\.(gcode|gco|g)$/i.test(newName)) newName += ".gcode";
    if (newName === g.name) return res.json({ ok: true, printer: g.p.name, renamed: g.name, to: newName });
    if (g.files.some(x => x.name === newName))
      return res.status(409).json({ error: "'" + newName + "' already exists on " + g.p.name + " — pick a different name." });
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(g.base + "/server/files/move?source=" + encodeURIComponent("gcodes/" + g.name) + "&dest=" + encodeURIComponent("gcodes/" + newName), { method: "POST", signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return res.status(502).json({ error: g.p.name + " refused rename: HTTP " + r.status + " " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, printer: g.p.name, renamed: g.name, to: newName });
  } catch (e) {
    res.status(502).json({ error: "Printer unreachable or errored: " + String(e.message || e) });
  }
});

// --- cross-printer transfer -----------------------------------------------------
// Hub-brokered copy: download from the source printer, stream straight into a
// multipart upload to the destination (no buffering — files run 200-400 MB and
// the packaged Hub must not hold them in RAM). Progress rides the existing
// JOBS map, so the UI polls /api/print-status exactly like a print push.
//   * No silent overwrite: Moonraker's upload replaces an existing name without
//     complaint (which could clobber a file the destination is PRINTING), so
//     the Hub refuses if the name exists on the destination at all.
//   * Write-then-verify: after the 201, the destination is re-listed and the
//     new file must appear at the source's exact byte size.
//   * Content-Length is promised from the source listing; if the file changes
//     mid-transfer the stream length won't match and the upload fails loudly.
function streamTransfer(srcBase, dstBase, name, size, job) {
  return new Promise((resolve, reject) => {
    const boundary = "----u1hub" + Math.random().toString(16).slice(2);
    const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    job.total = pre.length + size + post.length;
    job.sent = 0;
    const u = new URL(dstBase + "/server/files/upload");
    const up = http.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": job.total }
    }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", d => b += d);
      res.on("end", () => (res.statusCode < 300 ? resolve(b) : reject(new Error("Upload " + res.statusCode + ": " + b.slice(0, 160)))));
    });
    up.on("error", reject);
    http.get(srcBase + "/server/files/gcodes/" + encPath(name), dl => {
      if (dl.statusCode !== 200) {
        dl.resume(); up.destroy();
        return reject(new Error("Download from source failed: HTTP " + dl.statusCode));
      }
      up.write(pre); job.sent += pre.length;
      dl.on("data", chunk => {
        job.sent += chunk.length;
        if (!up.write(chunk)) { dl.pause(); up.once("drain", () => dl.resume()); }
      });
      dl.on("end", () => { up.write(post); job.sent += post.length; up.end(); });
      dl.on("error", reject);
    }).on("error", reject);
  });
}

// Body: { from: printerIdx, name, to: printerIdx } -> { jobId } (poll /api/print-status)
app.post("/api/printer-files/transfer", async (req, res) => {
  const { from, to } = req.body || {};
  const src = PRINTERS[from], dst = PRINTERS[to];
  if (!src || !dst) return res.status(400).json({ error: "Unknown printer" });
  if (src === dst) return res.status(400).json({ error: "Source and destination are the same printer" });
  const name = cleanRel((req.body || {}).name);
  if (!name) return res.status(400).json({ error: "Bad file name" });
  if (name.includes("/")) return res.status(400).json({ error: "Files in subfolders can't be transferred yet" });
  const srcBase = String(src.url).replace(/\/+$/, "");
  const dstBase = String(dst.url).replace(/\/+$/, "");
  try {
    const [srcFiles, dstFiles] = await Promise.all([listOnboard(src), listOnboard(dst)]);
    const f = srcFiles.find(x => x.name === name);
    if (!f) return res.status(404).json({ error: "'" + name + "' not found on " + src.name });
    if (dstFiles.some(x => x.name === name))
      return res.status(409).json({ error: "'" + name + "' already exists on " + dst.name + " — delete or rename it there first (the Hub never overwrites)." });
    const jobId = newJobId();
    const job = { file: name, phase: "transfer", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
    JOBS.set(jobId, job);
    res.json({ jobId });
    (async () => {
      try {
        await streamTransfer(srcBase, dstBase, name, f.size, job);
        job.phase = "verify";
        const after = await listOnboard(dst);
        const got = after.find(x => x.name === name);
        if (!got) throw new Error("Upload reported success but '" + name + "' is missing from " + dst.name + "'s listing");
        job.result = { from: src.name, to: dst.name, size: got.size, sizeVerified: got.size === f.size };
        job.phase = "done"; job.done = true;
      } catch (e) {
        job.error = String(e.message || e); job.done = true; job.phase = "error";
      }
    })();
  } catch (e) {
    res.status(502).json({ error: "Printer unreachable: " + String(e.message || e) });
  }
});

// --- queue routes -------------------------------------------------------------
// GET returns the whole queue (entries carry their type slug); pass ?type= to
// filter server-side. POST requires the file to exist in that type's folder.
app.get("/api/queue", (req, res) => {
  const slug = String(req.query.type || "");
  res.json({ queue: slug ? QUEUE.filter(e => e.type === slug) : QUEUE });
});

app.post("/api/queue", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile((req.body || {}).file, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  QUEUE.push({ id: Math.random().toString(36).slice(2, 10), file: path.basename(fp), added: Date.now(), type: t.slug });
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

// (The former inline /api/thumb route lived here; it shadowed the newer
// cached implementation further down. Removed 2026-07-19 — the cached route
// with thumbCache + long Cache-Control now actually serves.)

app.get("/api/map", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile(req.query.file, t);
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

// ---- Library palette index (for Spool Match) --------------------------------
// Spool Match needs every library file's required colours, not just the selected
// one. This re-uses the exact tail-read + parseGcodeMap path as /api/map, cached
// per file by (size, mtime) so a large library is parsed once and served
// instantly thereafter. Returns only what the matcher needs: the used palette
// hexes per file (plus FS / no-colour flags so the UI can label those).
const PAL_CACHE = new Map(); // "<slug>:<name>" -> { size, mtime, colors:[hex], usedCount, anyTC, isFS, noColors }
function paletteForFile(name, t) {
  t = t || typeBySlug("u1");
  const fp = safeFile(name, t);
  if (!fp || !fs.existsSync(fp)) return null;
  const st = fs.statSync(fp);
  const key = t.slug + ":" + name;
  const hit = PAL_CACHE.get(key);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit;
  const TAIL = 3 * 1024 * 1024;
  let text;
  if (st.size > TAIL) {
    const fd = fs.openSync(fp, "r");
    try { const buf = Buffer.alloc(TAIL); fs.readSync(fd, buf, 0, TAIL, st.size - TAIL); text = buf.toString("utf8"); }
    finally { fs.closeSync(fd); }
  } else { text = fs.readFileSync(fp, "utf8"); }
  let r = parseGcodeMap(text, { scanBody: false });
  if (r.noColors && st.size > TAIL) r = parseGcodeMap(fs.readFileSync(fp, "utf8"), { scanBody: true });
  const colors = (Array.isArray(r.palette) ? r.palette : []).filter(s => s && s.used && s.hex).map(s => s.hex);
  const rec = { size: st.size, mtime: st.mtimeMs, colors,
    usedCount: (r.usedIdx || []).length, anyTC: !!r.anyTC,
    isFS: !!r.isFS, noColors: !!r.noColors };
  PAL_CACHE.set(key, rec);
  return rec;
}
app.get("/api/library-palettes", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const dir = typeFolder(t);
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(gcode|gco|g)$/i.test(f));
    const live = new Set(files.map(f => t.slug + ":" + f));
    for (const k of PAL_CACHE.keys()) if (k.startsWith(t.slug + ":") && !live.has(k)) PAL_CACHE.delete(k); // drop deleted files
    const out = [];
    for (const name of files) {
      const rec = paletteForFile(name, t);
      if (rec) out.push({ name, colors: rec.colors, isFS: rec.isFS, noColors: rec.noColors });
    }
    res.json({ files: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

app.post("/api/print", async (req, res) => {
  const { file, printer, start, map, force } = req.body || {};
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile(file, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  // Structural cross-class block: the switcher already hides the other fleet,
  // but the server refuses too — a stale page or hand-crafted request can't
  // send a U1 file to a Sovol (or vice versa).
  if ((p.type || "u1") !== t.slug)
    return res.status(400).json({ error: p.name + " belongs to a different printer type ('" + (p.type || "u1") + "') — switch to that type to send this file." });

  // map is { logicalToolIndex: physicalHeadIndex }. Reject two tools → same head.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
    const heads = tools.map(t => map[t]);
    if (new Set(heads).size !== heads.length) {
      return res.status(400).json({ error: "Two colors are mapped to the same head — give each its own head." });
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
      if (tools.length) {                                 // 2) toolhead mapping macros
        job.phase = "mapping";
        const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
        lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + tools.map(t => map[t]).join(","));
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
  const ven  = ptc.filament_vendor || [];
  const sku  = ptc.filament_sku || [];
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
      official: !!off[i],
      // Identity (tag-verified spool profile). vendor/sku come straight from
      // print_task_config — the same source the color swatch uses, so they never
      // disagree with the displayed color, and (unlike filament_detect) they
      // don't go stale after the load-time RFID scan. Hardware-verified: an
      // official Snapmaker SnapSpeed roll reported vendor "Snapmaker", sku 900002.
      vendor: (loaded && off[i] && ven[i] && ven[i] !== "NONE") ? ven[i] : null,
      sku: (loaded && off[i] && sku[i]) ? sku[i] : null
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

// ---- Chamber camera (Snapmaker camera.* plugin) ----------------------------
// Hardware-verified 2026-08-05 (.88/.83): the U1's built-in chamber cam is NOT on
// any standard Moonraker webcam interface (/server/webcams/list empty, /webcam/
// 502, :8080 refused). It streams through Snapmaker's own plugin:
// camera.start_monitor {domain:"lan", interval:0} makes the plugin write ~1 fps
// JPEGs to /server/files/camera/monitor.jpg (fetched over plain HTTP);
// camera.stop_monitor ends it. Stream test confirmed continuous frames, first
// frame ~1.1s after start.
//
// The monitor must run on a DEDICATED socket — issuing start_monitor on the
// shared fleet-subscription socket does NOT take (verified: frames never
// advanced). So each printer gets its own lazy camera socket, opened on first
// snapshot request and closed by the idle reaper when no card is watching.
const CAM = new Map(); // idx -> { ws, open, monitoring, lastReq, startedAt, cooldownUntil }
const CAM_COOLDOWN_MS = 5000;   // plugin misbehaves if start_monitor is hammered
const CAM_IDLE_MS = 60000;      // stop the stream after this long with no viewers
const CAM_WARMUP_MS = 1400;     // first frame lands ~1.1s after start

function camConnect(idx) {
  const p = PRINTERS[idx];
  if (!p || typeof WebSocket === "undefined") return null;
  let c = CAM.get(idx);
  if (c && c.ws && (c.ws.readyState === 0 || c.ws.readyState === 1)) return c; // connecting/open
  if (c && Date.now() < c.cooldownUntil) return c;                              // throttle reconnect
  c = c || { ws: null, open: false, monitoring: false, lastReq: 0, startedAt: 0, cooldownUntil: 0 };
  const wsUrl = String(p.url).replace(/\/+$/, "").replace(/^http/, "ws") + "/websocket";
  let ws;
  try { ws = new WebSocket(wsUrl); } catch { c.cooldownUntil = Date.now() + CAM_COOLDOWN_MS; CAM.set(idx, c); return c; }
  c.ws = ws; c.open = false; c.monitoring = false; c.cooldownUntil = Date.now() + CAM_COOLDOWN_MS;
  ws.onopen = () => {
    c.open = true; c.startedAt = Date.now();
    try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "camera.start_monitor", params: { domain: "lan", interval: 0 }, id: 900 })); c.monitoring = true; } catch {}
  };
  ws.onmessage = (ev) => {
    let j; try { j = JSON.parse(ev.data); } catch { return; }
    if (j.method === "notify_camera_status_change" && Array.isArray(j.params) && j.params[0]) c.monitoring = !!j.params[0].monitoring;
  };
  ws.onerror = () => {};
  ws.onclose = () => { c.open = false; c.monitoring = false; };
  CAM.set(idx, c);
  return c;
}
// Ensure a live stream; returns true if this call had to (re)start it (cold).
function camEnsure(idx) {
  const prev = CAM.get(idx);
  const cold = !(prev && prev.open && prev.monitoring);
  const c = camConnect(idx);
  if (c) c.lastReq = Date.now();
  return cold;
}
function camStop(idx) {
  const c = CAM.get(idx);
  if (!c || !c.ws) return;
  try { if (c.open) c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "camera.stop_monitor", params: { domain: "lan" }, id: 901 })); } catch {}
  try { c.ws.close(); } catch {}
  c.open = false; c.monitoring = false; c.ws = null;
}
// Idle reaper: drop any camera socket nobody has watched for CAM_IDLE_MS.
setInterval(() => {
  const now = Date.now();
  for (const [idx, c] of CAM) if (c.ws && now - c.lastReq > CAM_IDLE_MS) camStop(idx);
}, 15000);

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
  // Capability layer: attach detected caps so the UI gates features on what the
  // machine actually reports, never on the type label. A generic Klipper box
  // (no print_task_config) gets its Snapmaker-specific heads array blanked —
  // decodeHeads on an absent object would fabricate 4 empty U1 heads.
  if (data && data.online) {
    const caps = await detectCaps(idx);
    data.caps = caps;
    if (caps && !caps.multiColor) { data.heads = []; data.mapTable = null; }
  }
  return data;
}
async function fleetSnapshot() {
  // `plug` is attached centrally (not threaded through every probe/offline
  // return) so a plugged-but-offline printer still shows its power tile — that's
  // exactly when you'd want to switch it on. Only the type is exposed; the plug
  // IP stays server-side (the browser drives it through /api/power?id=N).
  return Promise.all((PRINTERS || []).map((p, i) =>
    probeCached(p, i).then(r => ({ id: i, ptype: p.type || "u1", plug: p.plug ? { type: p.plug.type } : null, ...r }))));
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
function localThumb(name, t) {
  t = t || typeBySlug("u1");
  const full = path.join(typeFolder(t), path.basename(name));
  let stat; try { stat = fs.statSync(full); } catch { return null; }
  const key = "L:" + t.slug + ":" + name + ":" + stat.mtimeMs;
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
  const t = reqTypeOf(req);
  if (!t) return res.status(400).end();
  const name = path.basename(String(req.query.file || ""));
  if (!/\.gcode$/i.test(name)) return res.status(400).end();
  const png = localThumb(name, t);
  if (!png) return res.status(404).end();
  res.set("Cache-Control", "public, max-age=86400").type("png").send(png);
});
app.get("/api/pthumb", async (req, res) => {
  const p = PRINTERS[+req.query.id];
  const filename = String(req.query.file || "");
  if (!p || !filename) return res.status(400).end();
  // 1) local copy of the same file — verified extraction path (printer's own type folder)
  const local = localThumb(path.basename(filename), typeBySlug(p.type || "u1"));
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

// ---- Live chamber snapshot -------------------------------------------------
// The browser polls this per printer on a staggered interval and points an <img>
// at it. Ensures the plugin's monitor is running (starting it on first request),
// then proxies the latest frame. A cold start needs ~1s for the first frame, so
// we retry monitor.jpg once on a miss. Returns 503 (not 500) when there's simply
// no frame yet, so the UI can show a retryable placeholder rather than an error.
app.get("/api/camera", async (req, res) => {
  const idx = +req.query.id;
  const p = PRINTERS[idx];
  if (!p) return res.status(400).end();
  if (typeof WebSocket === "undefined") return res.status(503).json({ error: "no WebSocket client" });
  const cold = camEnsure(idx);   // opens the dedicated camera socket if needed
  const base = String(p.url).replace(/\/+$/, "");
  const grab = async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    try {
      const r = await fetch(base + "/server/files/camera/monitor.jpg", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) return null;
      const b = Buffer.from(await r.arrayBuffer());
      return (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) ? b : null; // valid JPEG SOI
    } catch { clearTimeout(to); return null; }
  };
  // On a cold start the stream needs ~1.1s to write its first frame; without the
  // wait we'd serve the stale monitor.jpg left on disk. Warm streams skip this.
  if (cold) await new Promise(r => setTimeout(r, CAM_WARMUP_MS));
  let jpg = await grab();
  if (!jpg) { await new Promise(r => setTimeout(r, 800)); jpg = await grab(); }
  if (!jpg) return res.status(503).json({ error: "no frame" });
  res.set("Cache-Control", "no-store").type("jpeg").send(jpg);
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

// ---- Smart power control: switch a printer's plug on/off + read draw -------
// Each printer MAY carry a typed `plug` descriptor in config.json:
//   "plug": { "type":"shelly", "ip":"192.168.12.235" }                  // metered on/off
//   "plug": { "type":"url", "on":"http://x/on", "off":"http://x/off" }  // any local-HTTP plug, on/off only
// Hardware-verified on a Shelly Plug US Gen4 (model S4PL-00116US, gen 4):
//   GET /rpc/Shelly.GetDeviceInfo  -> reachable, auth-optional (auth_en:false)
//   GET /rpc/Switch.GetStatus?id=0 -> { output, apower, voltage, aenergy:{total}, temperature:{tC} }
//   GET /rpc/Switch.Set?id=0&on=<bool> -> { was_on }
// The `shelly` driver reads live draw + energy; the generic `url` driver just
// fires the configured on/off URL (covers Tasmota, ESPHome, HA webhooks, DIY
// ESP32 — anything with a local HTTP endpoint) with no metering.
// SAFETY: turning a plug OFF is hard-blocked while its printer is printing or
// paused — a live print_stats query gates every off (same pattern as the file-
// management active-print guard). If we can't confirm the printer is idle, the
// off is refused (fail safe). Turning ON is always allowed. NOTE: this guard
// only covers the Hub's own Off button — the physical button, the Shelly app,
// and power outages are outside the Hub's reach.

async function plugRead(plug) {
  if (!plug || !plug.type) throw new Error("no plug configured");
  if (plug.type === "shelly") {
    const ip = String(plug.ip || "").trim();
    if (!ip) throw new Error("shelly plug missing 'ip'");
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch("http://" + ip + "/rpc/Switch.GetStatus?id=0", { signal: ctrl.signal });
      if (!r.ok) throw new Error("plug HTTP " + r.status);
      const s = await r.json();
      const ae = s.aenergy || {};
      const t = s.temperature || {};
      return {
        on: !!s.output,
        watts: typeof s.apower === "number" ? s.apower : null,
        volts: typeof s.voltage === "number" ? s.voltage : null,
        energyWh: typeof ae.total === "number" ? ae.total : null,
        tempC: typeof t.tC === "number" ? t.tC : null,
        metered: true
      };
    } finally { clearTimeout(to); }
  }
  if (plug.type === "url") {
    // generic plug: on/off only, no reliable status read
    return { on: null, watts: null, volts: null, energyWh: null, tempC: null, metered: false };
  }
  throw new Error("unknown plug type '" + plug.type + "'");
}

async function plugSet(plug, on) {
  if (!plug || !plug.type) throw new Error("no plug configured");
  if (plug.type === "shelly") {
    const ip = String(plug.ip || "").trim();
    if (!ip) throw new Error("shelly plug missing 'ip'");
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch("http://" + ip + "/rpc/Switch.Set?id=0&on=" + (on ? "true" : "false"), { signal: ctrl.signal });
      if (!r.ok) throw new Error("plug HTTP " + r.status);
      await r.json().catch(() => ({}));
    } finally { clearTimeout(to); }
    return;
  }
  if (plug.type === "url") {
    const target = on ? plug.on : plug.off;
    if (!target) throw new Error("url plug missing '" + (on ? "on" : "off") + "' endpoint");
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(String(target), { signal: ctrl.signal });
      if (!r.ok) throw new Error("plug HTTP " + r.status);
    } finally { clearTimeout(to); }
    return;
  }
  throw new Error("unknown plug type '" + plug.type + "'");
}

// Live print state for the off-guard (mirrors the file-management guard helper).
async function plugGuardState(base) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(base + "/printer/objects/query?print_stats", { signal: ctrl.signal });
    if (!r.ok) throw new Error("Moonraker " + r.status);
    const ps = ((((await r.json()).result) || {}).status || {}).print_stats || {};
    return ps.state || "unknown";
  } finally { clearTimeout(to); }
}

app.get("/api/power", async (req, res) => {
  const p = PRINTERS[req.query.id];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!p.plug) return res.status(404).json({ error: "No plug configured for " + (p.name || "printer") });
  try {
    const st = await plugRead(p.plug);
    res.json({ id: Number(req.query.id), type: p.plug.type, ...st });
  } catch (e) {
    res.status(502).json({ error: "Plug unreachable: " + e.message });
  }
});

app.post("/api/power", async (req, res) => {
  const b = req.body || {};
  const p = PRINTERS[b.id];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  if (!p.plug) return res.status(404).json({ error: "No plug configured for " + (p.name || "printer") });
  if (typeof b.on !== "boolean") return res.status(400).json({ error: "Body needs { id, on: true|false }" });
  // SAFETY: never cut power to a printer that is printing or paused.
  if (b.on === false) {
    const base = String(p.url).replace(/\/+$/, "");
    let state;
    try { state = await plugGuardState(base); }
    catch (e) { return res.status(502).json({ error: "Can't confirm " + p.name + " is idle (" + e.message + ") — refusing to power off." }); }
    if (state === "printing" || state === "paused")
      return res.status(409).json({ error: "REFUSED: " + p.name + " is " + state + " — the Hub won't cut power mid-print." });
  }
  try {
    await plugSet(p.plug, b.on);
    let st = null;
    try { st = await plugRead(p.plug); } catch {}
    res.json({ ok: true, id: Number(b.id), on: b.on, type: p.plug.type, ...(st || {}) });
  } catch (e) {
    res.status(502).json({ error: "Plug command failed: " + e.message });
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
  return { gcodeFolder: CFG.gcodeFolder || "./gcode", folderResolved: FOLDER, printers: PRINTERS,
    types: TYPES.map(t => ({ slug: t.slug, label: t.label, accent: t.accent, builtin: !!t.builtin, warning: TYPE_WARNINGS[t.slug] || null })),
    tip: CFG.tip || null, configured: PRINTERS.length > 0 };
}
app.get("/api/config", (req, res) => res.json(publicCfg()));
app.get("/api/version", (req, res) => res.json({ version: VERSION }));

// ---- Diagnostics bundle (v2.9, beta support) --------------------------------
// User-initiated ONLY — the Hub has zero telemetry and this keeps it that way.
// Settings → "Download diagnostics" produces one JSON the user reviews and
// attaches to a GitHub issue. Contents: version/platform, types + warnings,
// printers with DETECTED capabilities, the in-memory ring buffer, and the tail
// of each printer's klippy.log + moonraker.log fetched over Moonraker's file
// API with a suffix Range header (~192 KB per log — klippy.log can be tens of
// MB and we only ever want the recent end).
//
// Rule #1 note: HTTP 206 ranged GETs are hardware-verified on the Snapmaker
// fork for GCODE paths; /server/files/klippy.log on the fork is UNVERIFIED, so
// every log fetch is individually tolerant — a missing log becomes a note in
// the bundle, never a failed export. Stock Moonraker serves both logs there.
//
// Sanitization happens at generation, before the user ever sees the file:
//   * every configured printer host → stable alias ("printer-1", …) so reports
//     stay legible without leaking the LAN layout
//   * any remaining IPv4 (incl. loopback) → "x.x.x.x"
//   * JWT-shaped tokens (tunnel credentials pasted into logs) → "<token>"
//   * auth.json / tunnel.json contents are never read — only booleans ship
const DIAG_TAIL_BYTES = 192 * 1024;
async function diagFetchLogTail(base, file) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(base + "/server/files/" + file, {
      headers: { Range: "bytes=-" + DIAG_TAIL_BYTES }, signal: ctrl.signal
    });
    clearTimeout(to);
    if (r.status !== 200 && r.status !== 206)
      return { ok: false, note: "HTTP " + r.status + " — log not exposed at /server/files/" + file };
    // A server that ignores Range replies 200 with the WHOLE file. Refuse to
    // inline anything huge rather than ballooning the bundle (or Hub memory).
    const len = parseInt(r.headers.get("content-length") || "0", 10);
    if (r.status === 200 && len > 2 * 1024 * 1024)
      return { ok: false, note: "server ignored Range and the full log is " + (len / 1048576).toFixed(1) + " MB — too large to inline" };
    let text = await r.text();
    if (text.length > DIAG_TAIL_BYTES) text = text.slice(-DIAG_TAIL_BYTES);
    return { ok: true, ranged: r.status === 206, bytes: text.length, tail: text };
  } catch (e) {
    return { ok: false, note: String((e && e.message) || e) };
  }
}
app.get("/api/diagnostics", async (req, res) => {
  const withLogs = String(req.query.logs || "1") !== "0";
  const onlyIdx = req.query.printer !== undefined ? parseInt(req.query.printer, 10) : null;

  const printers = await Promise.all(PRINTERS.map(async (p, i) => ({
    alias: "printer-" + (i + 1),
    name: p.name, type: p.type || "u1",
    caps: (await detectCaps(i)) || null,
    plug: (p.plug && p.plug.type) || null
  })));

  let spoolsBound = 0, slotsAssigned = 0;
  try { const s = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "spools.json"), "utf8")); spoolsBound = Object.keys(s.spools || {}).length; } catch {}
  try {
    const sl = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "slots.json"), "utf8"));
    for (const m of Object.values(sl || {})) slotsAssigned += Object.keys(m || {}).length;
  } catch {}

  const bundle = {
    generatedAt: new Date().toISOString(),
    hub: { version: VERSION, node: process.version, platform: process.platform, arch: process.arch, pkg: IS_PKG, uptimeSec: Math.round(process.uptime()) },
    auth: { enabled: fs.existsSync(path.join(BASE_DIR, "auth.json")) },       // boolean only — contents never read
    tunnel: { configured: fs.existsSync(path.join(BASE_DIR, "tunnel.json")) }, // boolean only — contents never read
    types: TYPES.map(t => ({ slug: t.slug, label: t.label, builtin: !!t.builtin, beta: !t.builtin, warning: TYPE_WARNINGS[t.slug] || null, printerCount: PRINTERS.filter(p => (p.type || "u1") === t.slug).length })),
    printers,
    counts: { queue: QUEUE.length, spoolsBound, slotsAssigned },
    log: HUBLOG.slice(),
    klipperLogs: {}
  };

  if (withLogs) {
    for (let i = 0; i < PRINTERS.length; i++) {
      if (onlyIdx !== null && i !== onlyIdx) continue;
      const base = String(PRINTERS[i].url).replace(/\/+$/, "");
      bundle.klipperLogs["printer-" + (i + 1)] = {
        klippy: await diagFetchLogTail(base, "klippy.log"),
        moonraker: await diagFetchLogTail(base, "moonraker.log")
      };
    }
  }

  // Sanitize the SERIALIZED bundle so nothing slips through a nested field.
  let out = JSON.stringify(bundle, null, 2);
  PRINTERS.forEach((p, i) => {
    try {
      const host = new URL(p.url).hostname;
      if (host) out = out.split(host).join("printer-" + (i + 1));
    } catch {}
  });
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "x.x.x.x");
  out = out.replace(/eyJ[A-Za-z0-9._\-]{20,}/g, "<token>");
  res.type("json").send(out);
});

app.post("/api/config", (req, res) => {
  const b = req.body || {};
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (CFG.gcodeFolder || "./gcode"),
    port: PORT,
    types: CFG.types,   // types are managed via /api/types — a config save never drops them
    printers: Array.isArray(b.printers)
      ? b.printers.filter(p => p && p.url).map(p => {
          // Instance → type binding. Unknown/missing type falls back to the
          // grandfathered U1 so a stale frontend can't orphan a printer.
          const rec = { name: String(p.name || p.url), url: String(p.url), type: (p.type && typeBySlug(String(p.type))) ? String(p.type) : "u1" };
          // Plug descriptor. The settings form now sends the plug explicitly:
          //  - a valid {type,...} to set it,
          //  - null to clear it,
          //  - (field omitted) to preserve whatever's already there — this last case
          //    covers a hand-edited config saved from an older frontend that doesn't
          //    know about plugs. Validate the shape so a bad payload can't write junk.
          let plug = p.plug;
          if (plug === undefined) {
            const ex = (CFG.printers || []).find(x => x && x.url === p.url);
            if (ex && ex.plug) plug = ex.plug;
          }
          if (plug && plug.type === "shelly" && plug.ip) {
            rec.plug = { type: "shelly", ip: String(plug.ip).trim() };
          } else if (plug && plug.type === "url" && plug.on && plug.off) {
            rec.plug = { type: "url", on: String(plug.on).trim(), off: String(plug.off).trim() };
          }
          // anything else (null, unknown type, missing fields) → no plug written
          return rec;
        })
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
// Probe both known Moonraker ports: the U1 serves on :80 (Snapmaker quirk);
// stock Moonraker (e.g. Sovol SV06 Plus ACE) serves on :7125. The port rides
// in the printer's url, so every downstream call is per-instance automatically.
async function probeMoonraker(ip) {
  for (const port of [80, 7125]) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 900);
      const base = port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
      const r = await fetch(base + "/machine/system_info", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const si = ((await r.json()).result || {}).system_info;
      if (!si) continue;
      const pi = si.product_info || {};
      const { mac } = pickIface(si.network || {});
      return { ip, url: base, device_name: pi.device_name || null, machine_type: pi.machine_type || null, serial: pi.serial_number || null, mac };
    } catch { /* try next port */ }
  }
  return null;
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
