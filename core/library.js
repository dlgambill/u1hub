// core/library.js — types API, library files, printer files, queue routes, gcode color map, palette index
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { parseGcodeMap } = require("../parser");

module.exports = function (hub) {
const { ACCENT_PRESETS, app, onModule, plogOf, reqTypeOf, safeFile, saveConfigFile, savePrintLog, saveQueue, slugify, typeBySlug, typeFolder } = hub;


// ---- Types API ---------------------------------------------------------------
app.get("/api/types", (req, res) => {
  res.json({
    types: hub.TYPES.map(t => ({
      slug: t.slug, label: t.label, accent: t.accent, builtin: !!t.builtin,
      // v2.9 ships multi-printer-type as BETA: harness-verified against mock
      // printers, awaiting broad real-hardware verification (Rule #1 by proxy
      // — beta testers attach /api/diagnostics bundles to GitHub issues).
      beta: !t.builtin,
      folder: typeFolder(t),
      printerCount: hub.PRINTERS.filter(p => (p.type || "u1") === t.slug).length,
      warning: hub.TYPE_WARNINGS[t.slug] || null
    }))
  });
});


// "Add printer type" — deliberately separate from "Add printer": the user only
// names it; the Hub generates the immutable slug, creates <base>/<slug>/,
// assigns the next preset accent, and the switcher tab appears. Done once.
onModule("types-beta", () => {

app.post("/api/types", (req, res) => {
  const label = String((req.body || {}).label || "").trim();
  if (!label) return res.status(400).json({ error: "Type needs a name" });
  const slug = slugify(label);
  if (!slug) return res.status(400).json({ error: "Name must contain letters or numbers" });
  if (typeBySlug(slug)) return res.status(409).json({ error: "A type with slug '" + slug + "' already exists — its folder is locked to that type. Pick a different name." });
  const rec = { slug, label, accent: String((req.body || {}).accent || "").trim() || ACCENT_PRESETS[(hub.TYPES.length - 1) % ACCENT_PRESETS.length], folder: slug };
  const dir = typeFolder(rec);
  // Reuse-lock: refuse a folder that already belongs to (or nests with) another
  // type. Structural with auto-subfolders, but hand-edited configs exist.
  if (dir === hub.FOLDER || path.dirname(dir) !== hub.FOLDER)
    return res.status(400).json({ error: "Type folder must be a direct subfolder of the gcode base" });
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { return res.status(500).json({ error: "Could not create folder " + dir + " — " + e.message }); }
  hub.TYPES.push(rec); hub.CFG.types = hub.TYPES; saveConfigFile();
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
  hub.CFG.types = hub.TYPES; saveConfigFile();
  res.json({ ok: true, type: t });
});


// Delete/unbind a type: the folder is freed for reuse but gcode files are
// PRESERVED on disk — the Hub never auto-deletes a user's prints.
app.post("/api/types/delete", (req, res) => {
  const slug = String((req.body || {}).slug || "");
  const t = typeBySlug(slug);
  if (!t) return res.status(404).json({ error: "Unknown type" });
  if (t.builtin) return res.status(400).json({ error: "The built-in U1 type can't be deleted" });
  const inUse = hub.PRINTERS.filter(p => (p.type || "u1") === slug).length;
  if (inUse) return res.status(409).json({ error: inUse + " printer(s) still belong to '" + t.label + "' — reassign or remove them first." });
  hub.TYPES = hub.TYPES.filter(x => x.slug !== slug); hub.CFG.types = hub.TYPES;
  const qBefore = hub.QUEUE.length;
  hub.QUEUE = hub.QUEUE.filter(e => e.type !== slug);
  if (hub.QUEUE.length !== qBefore) saveQueue();
  delete hub.TYPE_WARNINGS[slug];
  saveConfigFile();
  res.json({ ok: true, note: "Folder and gcode files were preserved on disk." });
});
}); // end onModule("types-beta")


app.get("/api/printers", (req, res) => {
  res.json(hub.PRINTERS.map((p, i) => ({ id: i, name: p.name, type: p.type || "u1" })));
});


// v2.23 PERF (field-measured on Danny's phone, 2026-09-03: "7 seconds to
// load the Dash"). This listing was readdirSync + one statSync per file - 262
// synchronous round trips to the SMB share, 5.8 s on the production process,
// and because they are synchronous the whole server stood still for those
// 5.8 s: /api/fleet, which answers in 7 ms on its own, took 7 s whenever it
// arrived behind this. Every tab open, every 15 s poll and every tab switch
// paid it again. Now:
//   - the walk is asynchronous and the stats run in parallel (SMB pipelines
//     them; nothing else on the server waits);
//   - the result is kept for LIB_TTL_MS and concurrent callers share one walk,
//     so the pollers and a second tab cost nothing;
//   - delete and rename drop the cache so the UI reflects them at once; a file
//     that arrives from the slicer shows up within the TTL, well inside the
//     15 s the page polls at anyway.
// The cache is trusted only while the FOLDER's own mtime is unchanged (one
// stat, not 262): a file added, removed or renamed bumps it, so those are
// never served stale, whatever the TTL. The TTL only bounds the one case a
// directory mtime cannot see - a file overwritten in place under its own name.
// Measured after the first cut (async + parallel): the walk STILL took 4.7 s
// on the production process - each stat against this share is slow there,
// however they are issued - so the walk must not sit on the request path at
// all. It is a SNAPSHOT: warmed at boot, refreshed in the background, and a
// request pays for a walk only when the folder's mtime says its membership
// changed since the snapshot (a new, removed or renamed file), which is the
// one case worth waiting for.
const LIB_TTL_MS = 15000;               // in-place overwrites (same name) show within this
const LIB_WARM_MS = 30000;              // background refresh cadence
const LIB_SNAP = new Map();             // slug -> { at, dirMtime, dir, files }
const LIB_INFLIGHT = new Map();         // slug -> Promise (coalesce concurrent walks)
// A delete or rename the Hub itself performed is applied to the snapshot in
// place (and the folder's new mtime recorded), so the next request is instant
// and correct instead of paying a walk to rediscover what we just did.
async function libPatch(t, fn) {
  const snap = LIB_SNAP.get(t.slug);
  if (!snap) return;
  fn(snap.files);
  snap.files.sort((a, b) => b.mtime - a.mtime);
  try { snap.dirMtime = (await fs.promises.stat(typeFolder(t))).mtimeMs; } catch {}
}
const libRemove = (t, name) => libPatch(t, files => { const i = files.findIndex(f => f.name === name); if (i >= 0) files.splice(i, 1); });
const libRename = (t, from, to) => libPatch(t, files => { const f = files.find(x => x.name === from); if (f) f.name = to; });
async function walkLibrary(t) {
  const dir = typeFolder(t);
  const dirMtime = (await fs.promises.stat(dir)).mtimeMs;      // captured BEFORE the walk
  const names = (await fs.promises.readdir(dir)).filter(f => /\.(gcode|gco|g)$/i.test(f));
  const stats = await Promise.all(names.map(f => fs.promises.stat(path.join(dir, f)).catch(() => null)));
  const files = [];
  names.forEach((f, i) => { const st = stats[i]; if (st) files.push({ name: f, size: st.size, mtime: st.mtimeMs }); });
  files.sort((a, b) => b.mtime - a.mtime);
  return { at: Date.now(), dirMtime, dir, files };
}
function refreshLibrary(t) {
  const have = LIB_INFLIGHT.get(t.slug);
  if (have) return have;
  const p = walkLibrary(t).then(snap => {
      LIB_SNAP.set(t.slug, snap);
      // thumbs.js (loads later) keeps every file's thumbnail on local disk;
      // hand it the fresh membership so new arrivals are extracted off-path.
      if (hub.warmThumbs) hub.warmThumbs().catch(() => {});
      return snap;
    }).finally(() => LIB_INFLIGHT.delete(t.slug));
  LIB_INFLIGHT.set(t.slug, p);
  return p;
}
async function listLibrary(t) {
  const snap = LIB_SNAP.get(t.slug);
  if (!snap) return refreshLibrary(t);                           // nothing yet: must walk
  let dirMtime = snap.dirMtime;
  try { dirMtime = (await fs.promises.stat(typeFolder(t))).mtimeMs; } catch {}
  if (dirMtime !== snap.dirMtime) return refreshLibrary(t);      // membership changed: walk now
  if (Date.now() - snap.at > LIB_TTL_MS) refreshLibrary(t).catch(() => {});   // stale-while-revalidate
  return snap;
}
// Warm at boot and keep warm, so the first page load after a restart never
// pays for the walk either. Config reloads swap hub.TYPES; the timer reads it live.
{
  const warm = () => { for (const t of (hub.TYPES || [])) refreshLibrary(t).catch(() => {}); };
  const t0 = setTimeout(warm, 1500); if (t0.unref) t0.unref();
  const tick = setInterval(warm, LIB_WARM_MS); if (tick.unref) tick.unref();
}

app.get("/api/files", async (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const plog = plogOf(t.slug);
  try {
    const { dir, files } = await listLibrary(t);
    // lastPrinted is attached per request, not cached: the print log changes
    // independently of the folder.
    res.json({ folder: dir, type: t.slug, files: files.map(f => ({ ...f, lastPrinted: plog[f.name] || null })) });
  } catch (e) {
    const dir = typeFolder(t);
    res.status(500).json({ error: "Cannot read folder " + dir + " — " + e.message + (hub.TYPE_WARNINGS[t.slug] ? " · " + hub.TYPE_WARNINGS[t.slug] : "") });
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
  // v2.23 PERF: 2.5 s, was 5. One slow printer held the whole nine-printer
  // listing (and a browser connection) to the full timeout on every poll.
  const to = setTimeout(() => ctrl.abort(), 2500);
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
// v2.23 PERF: the nine-printer listing is a SNAPSHOT too. Measured on
// production it took 5-9 s per call (one slow printer running the old timeout
// out on every poll), and the page asks for it at load and every 15 s. A
// request is served from the last snapshot at once and triggers a background
// refresh when it is older than PF_SOFT_MS; only a request with nothing to
// serve (first after boot, or a stale one past PF_HARD_MS) waits for the
// printers. Printer-side delete/rename/transfer (and a push from the library)
// drop the snapshot and re-fetch at once, so what you just did is visible on
// the next poll. The keys the pages actually ask for (all printers, and each
// type's instances) are warmed at boot and kept warm, so the first load after
// a restart or an idle spell does not wait on the printers either.
const PF_SOFT_MS = 15000, PF_HARD_MS = 90000, PF_WARM_MS = 30000;
const PF_SNAP = new Map();      // key -> { at, printers }
const PF_INFLIGHT = new Map();  // key -> Promise
function pfTargets(want, slug) {
  let targets = (want === undefined)
    ? hub.PRINTERS.map((p, i) => ({ p, i }))
    : (hub.PRINTERS[want] ? [{ p: hub.PRINTERS[want], i: Number(want) }] : null);
  if (!targets) return null;
  if (slug) targets = targets.filter(({ p }) => (p.type || "u1") === slug);
  const key = String(want === undefined ? "*" : want) + "|" + slug + "|" + targets.map(t => t.i).join(",");
  return { targets, key };
}
function warmPrinterFiles() {
  const asks = [{ slug: "" }, ...(hub.TYPES || []).map(t => ({ slug: t.slug }))];
  for (const { slug } of asks) {
    const r = pfTargets(undefined, slug);
    if (r && r.targets.length) fetchPrinterFiles(r.key, r.targets).catch(() => {});
  }
}
function invalidatePrinterFiles() { PF_SNAP.clear(); warmPrinterFiles(); }
{
  const t0 = setTimeout(warmPrinterFiles, 2000); if (t0.unref) t0.unref();
  const tick = setInterval(warmPrinterFiles, PF_WARM_MS); if (tick.unref) tick.unref();
}
function fetchPrinterFiles(key, targets) {
  const have = PF_INFLIGHT.get(key);
  if (have) return have;
  const p = Promise.all(targets.map(async ({ p, i }) => {
    try { return { id: i, name: p.name, online: true, files: await listOnboard(p) }; }
    catch (e) { return { id: i, name: p.name, online: false, error: String(e.message || e), files: [] }; }
  })).then(printers => { const snap = { at: Date.now(), printers }; PF_SNAP.set(key, snap); return snap; })
    .finally(() => PF_INFLIGHT.delete(key));
  PF_INFLIGHT.set(key, p);
  return p;
}
app.get("/api/printer-files", async (req, res) => {
  const want = req.query.printer;
  const slug = String(req.query.type || "");   // optional: only that type's instances
  const r0 = pfTargets(want, slug);
  if (!r0) return res.status(400).json({ error: "Unknown printer " + want });
  const { targets, key } = r0;
  const snap = PF_SNAP.get(key);
  const age = snap ? Date.now() - snap.at : Infinity;
  if (snap && age < PF_HARD_MS) {
    if (age > PF_SOFT_MS) fetchPrinterFiles(key, targets).catch(() => {});   // stale-while-revalidate
    return res.json({ printers: snap.printers });
  }
  try { res.json({ printers: (await fetchPrinterFiles(key, targets)).printers }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
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
  for (const j of hub.JOBS.values()) if (!j.done && j.file === name) return true;
  return false;
}


app.post("/api/files/delete", async (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const name = path.basename(String((req.body || {}).name || ""));
  const fp = safeFile(name, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found: " + name });
  if (hub.QUEUE.some(q => q.file === name && q.type === t.slug))
    return res.status(409).json({ error: "'" + name + "' is in the print queue — remove it from the queue first." });
  if (activePushOf(name))
    return res.status(409).json({ error: "'" + name + "' is being sent to a printer right now — wait for the upload to finish." });
  try { fs.unlinkSync(fp); }
  catch (e) { return res.status(500).json({ error: "Delete failed: " + e.message }); }
  await libRemove(t, name);
  const plog = plogOf(t.slug);
  if (plog[name] !== undefined) { delete plog[name]; savePrintLog(); }
  res.json({ ok: true, deleted: name });
});


app.post("/api/files/rename", async (req, res) => {
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
  await libRename(t, name, newName);
  let queueTouched = false;
  for (const q of hub.QUEUE) if (q.file === name && q.type === t.slug) { q.file = newName; queueTouched = true; }
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
  const p = hub.PRINTERS[(req.body || {}).printer];
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
    invalidatePrinterFiles();
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
    invalidatePrinterFiles();
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
  const src = hub.PRINTERS[from], dst = hub.PRINTERS[to];
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
    const jobId = hub.newJobId();
    const job = { file: name, phase: "transfer", sent: 0, total: 0, done: false, error: null, result: null, ts: Date.now() };
    hub.JOBS.set(jobId, job);
    res.json({ jobId });
    (async () => {
      try {
        await streamTransfer(srcBase, dstBase, name, f.size, job);
        job.phase = "verify";
        const after = await listOnboard(dst);
        const got = after.find(x => x.name === name);
        if (!got) throw new Error("Upload reported success but '" + name + "' is missing from " + dst.name + "'s listing");
        job.result = { from: src.name, to: dst.name, size: got.size, sizeVerified: got.size === f.size };
        invalidatePrinterFiles();
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
  res.json({ queue: slug ? hub.QUEUE.filter(e => e.type === slug) : hub.QUEUE });
});


app.post("/api/queue", (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).json({ error: "Unknown printer type" });
  const fp = safeFile((req.body || {}).file, t);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  hub.QUEUE.push({ id: Math.random().toString(36).slice(2, 10), file: path.basename(fp), added: Date.now(), type: t.slug });
  saveQueue();
  res.json({ ok: true, queue: hub.QUEUE });
});


app.post("/api/queue/remove", (req, res) => {
  const i = hub.QUEUE.findIndex(e => e.id === (req.body || {}).id);
  if (i === -1) return res.status(404).json({ error: "Not in queue" });
  hub.QUEUE.splice(i, 1); saveQueue();
  res.json({ ok: true, queue: hub.QUEUE });
});


app.post("/api/queue/reorder", (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids must be an array" });
  const byId = new Map(hub.QUEUE.map(e => [e.id, e]));
  const next = ids.map(id => byId.get(id)).filter(Boolean);
  hub.QUEUE.forEach(e => { if (!next.includes(e)) next.push(e); }); // never drop entries the client didn't know about
  hub.QUEUE = next; saveQueue();
  res.json({ ok: true, queue: hub.QUEUE });
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
    // The Orca config block (colors + "filament used [g]") lives at the END of
    // the file, so read just the tail — turns a 200MB read into ~2MB and skips
    // the body scan entirely. Fall back to the whole file only if the color
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
      // Colors weren't in the tail — fall back to a full parse (rare).
      result = parseGcodeMap(fs.readFileSync(fp, "utf8"), { scanBody: true });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ---- Library palette index (for Spool Match) --------------------------------
// Spool Match needs every library file's required colors, not just the selected
// one. This re-uses the exact tail-read + parseGcodeMap path as /api/map, cached
// per file by (size, mtime) so a large library is parsed once and served
// instantly thereafter. Returns only what the matcher needs: the used palette
// hexes per file (plus FS / no-color flags so the UI can label those).
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
  // Per-palette-index hex, kept unfiltered: /api/print needs to ask "are these
  // two logical tools actually the same color?" and the filtered `colors` array
  // above has lost its index alignment.
  const hexByIdx = {};
  if (Array.isArray(r.palette)) for (const s of r.palette) if (s && s.hex != null && s.i != null) hexByIdx[s.i] = s.hex;
  const rec = { size: st.size, mtime: st.mtimeMs, colors, hexByIdx,
    usedCount: (r.usedIdx || []).length, anyTC: !!r.anyTC,
    isFS: !!r.isFS, noColors: !!r.noColors };
  PAL_CACHE.set(key, rec);
  return rec;
}

onModule("match", () => {

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
}); // end onModule("match")

Object.assign(hub, { paletteForFile, invalidatePrinterFiles, librarySnapshot: t => LIB_SNAP.get(t.slug) || null });
};
