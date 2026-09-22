// modules/models.js — the 3MF model library (v2.26, "Models" tab).
//
// The gcode library is what the Hub prints. This is the shelf BEHIND it: the
// project files you have not sliced yet — a designer's colored 3MF from
// MyMiniFactory, a Printables download, your own saved project — organized on
// disk as <folder>\<Creator>\<Model>\*.3mf (any depth up to four works; the
// first two folder levels become the creator and model columns).
//
// What the tab gives you that Explorer does not: the plate thumbnail the
// designer saved inside the file, the filament colors the project was painted
// with (so you can see a four-color model IS a four-color model before you
// open it), the objects on the plate, and one button that opens the file in
// Snapmaker Orca on the Hub computer and then watches the gcode folder so the
// new file appears with a "select it / send to Dispatch" card the moment you
// save. That last part is the same trick the Slice tab has; it lives here too
// because this tab is on by default and the Slice tab is not.
//
// Deliberately not here: slicing. Orca does the slicing, in front of you.
// The Hub only finds, shows and hands over. And this tab is a desktop tab -
// the client hides it on a phone, because a button that opens Orca on a
// computer you are not sitting at is not a feature.
//
// Index: one recursive walk, cached; refreshed in the background when it is
// older than ten minutes or when the folder's own mtime changes, and on
// demand from the Rescan button. A 30,000-file library is a possibility here
// (that is the size of a full MyMiniFactory archive), so the list is filtered
// and paged on the server; the browser never gets the whole thing.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { zipEntryContent } = require("./slicing.js");   // pure helper (inflate); the slicing module itself need not be on

const INDEX_TTL_MS = 10 * 60 * 1000;
const MAX_DEPTH = 4;
const MAX_FILES = 60000;
const PAGE_DEFAULT = 60;
const SKIP_DIR = /^[._]|^(node_modules|manifests|tool|_consumed|_stage|_reports)$/i;
const THUMB_MAX = 400;             // disk cache entries kept (LRU by touch)

// ---- zip by ranges (v2.27.1) ------------------------------------------------
// The first cut read each 3MF whole to pull a 7 KB PNG out of it. Sixty
// cards on the tab meant 1.2 GB over the share, and on the night the share
// was crawling (60 KB/s) each thumbnail took two minutes and everything else
// queued behind the reads. A zip's directory sits at its END, so three small
// reads are enough: the last 64 KB (end-of-central-directory + the
// directory for any project 3MF), then the one entry's local header, then
// its compressed bytes. 20 MB becomes ~100 KB. Nothing here blocks the loop.
async function zipOpen(fp) {
  const fh = await fs.promises.open(fp, "r");
  try { return await zipIndex(fh); }
  catch (e) { await fh.close().catch(() => {}); throw e; }
}
async function zipIndex(fh) {
  const st = await fh.stat();
  const size = st.size;
  const tailLen = Math.min(size, 65536 + 22);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (EOCD missing)");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  // The central directory is usually inside the tail we already have.
  let cd;
  const tailStart = size - tailLen;
  if (cdOff >= tailStart) cd = tail.subarray(cdOff - tailStart, cdOff - tailStart + cdSize);
  else { cd = Buffer.alloc(cdSize); await fh.read(cd, 0, cdSize, cdOff); }
  const entries = [];
  let off = 0;
  for (let n = 0; n < count && off + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(off) !== 0x02014b50) break;
    const method = cd.readUInt16LE(off + 10), csize = cd.readUInt32LE(off + 20), usize = cd.readUInt32LE(off + 24);
    const nlen = cd.readUInt16LE(off + 28), elen = cd.readUInt16LE(off + 30), clen = cd.readUInt16LE(off + 32);
    const lho = cd.readUInt32LE(off + 42);
    entries.push({ name: cd.toString("utf8", off + 46, off + 46 + nlen), method, csize, usize, lho });
    off += 46 + nlen + elen + clen;
  }
  return {
    entries, size,
    async content(e) {
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, e.lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error("local header corrupt for " + e.name);
      const dataOff = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const raw = Buffer.alloc(e.csize);
      await fh.read(raw, 0, e.csize, dataOff);
      return zipEntryContent({ ...e, raw });
    },
    close: () => fh.close()
  };
}
// At most two 3MFs open at once. A grid of sixty cards must not open sixty
// files on a network share in the same second.
let ZIP_BUSY = 0; const ZIP_WAIT = [];
async function withZip(fp, fn) {
  if (ZIP_BUSY >= 2) await new Promise(r => ZIP_WAIT.push(r));
  ZIP_BUSY++;
  let z = null;
  try { z = await zipOpen(fp); return await fn(z); }
  finally { if (z) await z.close().catch(() => {}); ZIP_BUSY--; const next = ZIP_WAIT.shift(); if (next) next(); }
}

// Server twin of app.js nameMatcher (v2.24): plain substring, * and ?, -word.
function nameMatcher(q) {
  const terms = String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  const tests = terms.map(t => {
    let neg = false;
    if (t.length > 1 && t[0] === "-") { neg = true; t = t.slice(1); }
    let fn;
    if (/[*?]/.test(t)) {
      const re = new RegExp("^" + t.split(/([*?])/).map(p => p === "*" ? ".*" : p === "?" ? "." : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("") + "$");
      fn = n => re.test(n);
    } else fn = n => n.includes(t);
    return neg ? n => !fn(n) : fn;
  });
  return name => { const n = String(name || "").toLowerCase(); return tests.every(fn => fn(n)); };
}

// rel "Creator/Model/file.3mf" -> { creator, model, name }
function split(rel) {
  const parts = rel.split("/");
  const name = parts[parts.length - 1].replace(/\.3mf$/i, "");
  if (parts.length >= 3) return { creator: parts[0], model: parts[1], name };
  if (parts.length === 2) return { creator: parts[0], model: name, name };
  return { creator: "", model: name, name };
}

// Everything the card shows, read from inside the zip. Pure; exported for the harness.
// infoFromEntries takes zipRead() entries (bytes in memory); infoFromParts takes
// the two config members as Buffers, which is what the range reader hands over.
function infoFromEntries(entries) {
  const byName = new Map(entries.map(e => [e.name, e]));
  const ps = byName.get("Metadata/project_settings.config"), ms = byName.get("Metadata/model_settings.config");
  return infoFromParts(ps ? zipEntryContent(ps) : null, ms ? zipEntryContent(ms) : null);
}
function infoFromParts(ps, ms) {
  const out = { colors: [], printer: null, objects: [], plates: 0, sliced_for: null, layer_height: null };
  if (ps) {
    try {
      const j = JSON.parse(ps.toString("utf8"));
      const cols = Array.isArray(j.filament_colour) ? j.filament_colour : (typeof j.filament_colour === "string" ? j.filament_colour.split(";") : []);
      out.colors = cols.map(c => String(c || "").trim().toUpperCase()).filter(c => /^#[0-9A-F]{6}$/.test(c));
      out.printer = j.printer_model || j.printer_settings_id || null;
      out.layer_height = j.layer_height != null ? String(j.layer_height) : null;
    } catch {}
  }
  if (ms) {
    try {
      const t = ms.toString("utf8");
      // Objects are <object id="..."> blocks whose first name metadata is the object's name.
      for (const m of t.matchAll(/<object\s[^>]*>([\s\S]*?)<\/object>/g)) {
        const nm = /<metadata key="name" value="([^"]*)"/.exec(m[1]);
        const ex = /<metadata key="extruder" value="(\d+)"/.exec(m[1]);
        out.objects.push({ name: nm ? nm[1] : "object", extruder: ex ? Number(ex[1]) : null });
      }
      out.plates = (t.match(/<plate>/g) || []).length;
    } catch {}
  }
  // Which chips to show. A designer's project normally defines exactly the
  // filaments it paints with (checked against real MyMiniFactory files:
  // 2, 3, 4, 5 entries, all used), and painted faces inside one object use
  // colors the object's own extruder number never mentions - so the full
  // list is the honest one. Only when a project carries a whole 16-slot
  // palette does the card fall back to the extruders objects reference.
  const used = new Set(out.objects.map(o => o.extruder).filter(n => Number.isInteger(n) && n >= 1));
  out.colors_used = out.colors.length <= 8 || !used.size
    ? out.colors
    : [...used].sort((a, b) => a - b).map(n => out.colors[n - 1]).filter(Boolean);
  return out;
}

function pickThumb(entries) {
  const order = [/^Metadata\/plate_1_small\.png$/i, /^Metadata\/plate_\d+_small\.png$/i, /^Metadata\/plate_1\.png$/i, /^Metadata\/plate_\d+\.png$/i,
                 /^Metadata\/thumbnail.*\.png$/i, /^Thumbnails\/.*\.png$/i, /^Metadata\/.*\.png$/i];
  for (const re of order) { const e = entries.find(x => re.test(x.name)); if (e) return e; }
  return null;
}

function register(ctx) {
  const { app, hublog } = ctx;
  const conf = () => {
    const c = (ctx.cfg && typeof ctx.cfg.models === "object" && ctx.cfg.models) || {};
    const sl = (ctx.cfg && typeof ctx.cfg.slicer === "object" && ctx.cfg.slicer) || {};
    return {
      folder: path.resolve(String(c.folder || sl.srcFolder || path.join(ctx.baseDir, "models"))),
      orcaExe: String(sl.orcaExe || "C:\\Program Files\\Snapmaker_Orca\\snapmaker-orca.exe")
    };
  };
  const THUMB_DIR = path.join(ctx.baseDir, "thumbs", "models");
  try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch {}

  // ---- index ----------------------------------------------------------------
  let INDEX = null;          // { at, folder, dirMtime, items, creators }
  let WALKING = null;        // Promise while a walk is in flight
  let LAST_ERR = null;
  // v2.27.1: the index is kept on local disk too. A walk of a thousand files
  // on a share having a slow night takes minutes; a restart (or a Save of the
  // folder) used to make the tab wait on that walk before showing anything.
  // Now the last good index is served at once and the walk refreshes it.
  const INDEX_FILE = path.join(ctx.baseDir, "models-index.json");
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    if (j && Array.isArray(j.items) && j.folder) INDEX = { ...j, at: 0 };   // at:0 = stale, refresh soon
  } catch {}
  const saveIndex = () => { try { fs.writeFileSync(INDEX_FILE, JSON.stringify({ folder: INDEX.folder, dirMtime: INDEX.dirMtime, items: INDEX.items, creators: INDEX.creators, truncated: !!INDEX.truncated, saved: Date.now() })); } catch {} };

  async function walk() {
    const c = conf();
    const items = [];
    let truncated = false;
    async function rec(dir, rel, depth) {
      let ents;
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of ents) {
        if (items.length >= MAX_FILES) { truncated = true; return; }
        if (it.isDirectory()) {
          if (SKIP_DIR.test(it.name)) continue;
          if (depth < MAX_DEPTH) await rec(path.join(dir, it.name), rel + it.name + "/", depth + 1);
          continue;
        }
        if (!/\.3mf$/i.test(it.name)) continue;
        let st = null;
        try { st = await fs.promises.stat(path.join(dir, it.name)); } catch { continue; }
        const r = rel + it.name;
        items.push({ rel: r, ...split(r), size: st.size, mtime: st.mtimeMs });
      }
    }
    let dirMtime = 0;
    try { dirMtime = (await fs.promises.stat(c.folder)).mtimeMs; }
    catch (e) {
      LAST_ERR = "folder not reachable: " + c.folder;
      // A share that is off for a minute must not erase a good index. Keep
      // the last one (marked) and only say "missing" when there never was one.
      if (INDEX && INDEX.folder === c.folder && INDEX.items.length) { INDEX.unreachable = Date.now(); return INDEX; }
      INDEX = { at: Date.now(), folder: c.folder, dirMtime: 0, items: [], creators: [], missing: true };
      return INDEX;
    }
    await rec(c.folder, "", 0);
    items.sort((a, b) => a.creator.localeCompare(b.creator) || a.model.localeCompare(b.model) || a.name.localeCompare(b.name));
    const cmap = new Map();
    for (const it of items) cmap.set(it.creator, (cmap.get(it.creator) || 0) + 1);
    const creators = [...cmap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
    LAST_ERR = null;
    INDEX = { at: Date.now(), folder: c.folder, dirMtime, items, creators, truncated };
    saveIndex();
    hublog("info", "models: indexed " + items.length + " 3MF file" + (items.length === 1 ? "" : "s") + " in " + c.folder + (truncated ? " (capped)" : ""));
    return INDEX;
  }
  function refresh() {
    if (WALKING) return WALKING;
    WALKING = walk().catch(e => { LAST_ERR = e.message; return INDEX; }).finally(() => { WALKING = null; });
    return WALKING;
  }
  // Answers from what is known NOW and kicks the walk off in the background.
  // The only time a request waits is when nothing at all has ever been
  // indexed for this folder - and even then it gives up after a few seconds
  // and answers "scanning", so the tab can draw and poll.
  async function index(force) {
    const c = conf();
    const usable = INDEX && INDEX.folder === c.folder;
    if (force || !usable) {
      const p = refresh();
      if (usable) return INDEX;
      const timeout = new Promise(r => setTimeout(() => r(null), 4000));
      const got = await Promise.race([p, timeout]);
      return got || { at: 0, folder: c.folder, dirMtime: 0, items: [], creators: [], scanning: true };
    }
    let dirMtime = INDEX.dirMtime;
    try { dirMtime = (await fs.promises.stat(c.folder)).mtimeMs; } catch {}
    if (dirMtime !== INDEX.dirMtime || Date.now() - INDEX.at > INDEX_TTL_MS) refresh();   // stale-while-revalidate, always
    return INDEX;
  }
  // Safe absolute path for a rel from the index (or any rel under the folder).
  function safePath(rel) {
    const c = conf();
    const p = path.resolve(c.folder, String(rel || "").replace(/\//g, path.sep));
    if (!p.startsWith(c.folder + path.sep)) return null;
    if (!/\.3mf$/i.test(p)) return null;
    return p;
  }

  // ---- routes -----------------------------------------------------------------
  app.get("/api/models", async (req, res) => {
    const q = req.query || {};
    const ix = await index(String(q.refresh || "") === "1");
    const match = nameMatcher(q.q);
    const creator = q.creator ? String(q.creator) : null;
    let list = ix.items;
    if (creator) list = list.filter(it => it.creator === creator);
    if (q.q) list = list.filter(it => match(it.creator + "/" + it.model + "/" + it.name));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || PAGE_DEFAULT));
    const c = conf();
    res.json({
      folder: ix.folder, missing: !!ix.missing, unreachable: ix.unreachable || null, scanning: !!ix.scanning, error: LAST_ERR,
      indexed_at: ix.at, refreshing: !!WALKING, truncated: !!ix.truncated,
      total_all: ix.items.length, total: list.length, offset, limit,
      creators: ix.creators,
      items: list.slice(offset, offset + limit),
      orcaExe: c.orcaExe, orca_found: fs.existsSync(c.orcaExe)
    });
  });

  // v2.27.1: a blank folder field no longer clears the setting. The form
  // drew blank inputs while the list was still loading, and a Save pressed
  // then wiped the folder back to the default (2026-09-22, access.log:
  // two saves, list gone). Blank = keep; { clear: true } is the way to reset.
  app.post("/api/models/settings", (req, res) => {
    const b = req.body || {};
    const cur = (ctx.cfg.models && typeof ctx.cfg.models === "object") ? ctx.cfg.models : {};
    const next = { ...cur };
    const f = "folder" in b ? String(b.folder || "").trim() : null;
    if (f) next.folder = f; else if (b.clear === true) delete next.folder;
    ctx.cfg.models = next;
    if ("orcaExe" in b) {
      const sl = (ctx.cfg.slicer && typeof ctx.cfg.slicer === "object") ? { ...ctx.cfg.slicer } : {};
      const x = String(b.orcaExe || "").trim();
      if (x) sl.orcaExe = x; else if (b.clear === true) delete sl.orcaExe;
      ctx.cfg.slicer = sl;
    }
    ctx.saveConfig();
    refresh();
    const c = conf();
    res.json({ ok: true, folder: c.folder, folder_found: fs.existsSync(c.folder), orcaExe: c.orcaExe, orca_found: fs.existsSync(c.orcaExe) });
  });

  // Thumbnail: the plate PNG the designer saved inside the file, cached on
  // local disk keyed by path + mtime, so a 20 MB project on the share is
  // opened once, not on every scroll.
  const THUMB_MEM = new Map();
  app.get("/api/models/thumb", async (req, res) => {
    const p = safePath(req.query.file);
    if (!p) return res.status(404).end();
    let st; try { st = await fs.promises.stat(p); } catch { return res.status(404).end(); }
    const key = crypto.createHash("sha1").update(p).digest("hex").slice(0, 16) + "." + Math.round(st.mtimeMs);
    const cf = path.join(THUMB_DIR, key + ".png");
    res.setHeader("Cache-Control", "private, max-age=86400");
    if (THUMB_MEM.has(key)) return res.type("png").send(THUMB_MEM.get(key));
    try {
      const buf = await fs.promises.readFile(cf);
      THUMB_MEM.set(key, buf); if (THUMB_MEM.size > 200) THUMB_MEM.delete(THUMB_MEM.keys().next().value);
      return res.type("png").send(buf);
    } catch {}
    try {
      const png = await withZip(p, async z => { const e = pickThumb(z.entries); return e ? z.content(e) : null; });
      if (!png) { return res.status(404).end(); }
      THUMB_MEM.set(key, png); if (THUMB_MEM.size > 200) THUMB_MEM.delete(THUMB_MEM.keys().next().value);
      fs.promises.writeFile(cf, png).then(() => pruneThumbs()).catch(() => {});
      res.type("png").send(png);
    } catch { res.status(422).end(); }
  });
  let PRUNING = false;
  async function pruneThumbs() {
    if (PRUNING) return; PRUNING = true;
    try {
      const names = await fs.promises.readdir(THUMB_DIR);
      if (names.length <= THUMB_MAX) return;
      const stats = await Promise.all(names.map(async n => { try { return { n, at: (await fs.promises.stat(path.join(THUMB_DIR, n))).atimeMs }; } catch { return null; } }));
      stats.filter(Boolean).sort((a, b) => a.at - b.at).slice(0, names.length - THUMB_MAX).forEach(s => fs.promises.unlink(path.join(THUMB_DIR, s.n)).catch(() => {}));
    } catch {} finally { PRUNING = false; }
  }

  const INFO = new Map();
  app.get("/api/models/info", async (req, res) => {
    const p = safePath(req.query.file);
    if (!p) return res.status(404).json({ error: "not in the models folder" });
    let st; try { st = await fs.promises.stat(p); } catch { return res.status(404).json({ error: "file not found" }); }
    const key = p + ":" + st.mtimeMs;
    if (INFO.has(key)) return res.json(INFO.get(key));
    try {
      const parts = await withZip(p, async z => {
        const ps = z.entries.find(e => e.name === "Metadata/project_settings.config");
        const ms = z.entries.find(e => e.name === "Metadata/model_settings.config");
        return [ps ? await z.content(ps) : null, ms ? await z.content(ms) : null];
      });
      const info = { file: req.query.file, size: st.size, mtime: st.mtimeMs, ...infoFromParts(parts[0], parts[1]) };
      INFO.set(key, info); if (INFO.size > 500) INFO.delete(INFO.keys().next().value);
      res.json(info);
    } catch (e) { res.status(422).json({ error: "could not read the 3MF: " + e.message }); }
  });

  // Open in Orca on the Hub computer, then watch the gcode folder for what
  // comes out. Same behavior as the Slice tab's button (hardware-verified
  // 2026-08-29: Snapmaker Orca opens a 3MF passed as its one argument).
  let SEQ = 0;
  const SESSIONS = new Map();
  app.post("/api/models/open", (req, res) => {
    const b = req.body || {};
    const p = safePath(b.file);
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not in the models folder: " + String(b.file || "") });
    const c = conf();
    if (!fs.existsSync(c.orcaExe)) return res.status(503).json({ error: "Snapmaker Orca not found at " + c.orcaExe + " - set the path in Settings → Models" });
    const slug = String(b.type || "u1");
    let gdir; try { gdir = ctx.gcodeFolderFor(slug); } catch { gdir = null; }
    const snap = () => { try { return new Map(fs.readdirSync(gdir).filter(f => /\.gcode$/i.test(f)).map(f => { try { return [f, fs.statSync(path.join(gdir, f)).mtimeMs]; } catch { return [f, 0]; } })); } catch { return new Map(); } };
    const before = gdir ? snap() : new Map();
    try { spawn(c.orcaExe, [p], { detached: true, stdio: "ignore" }).unref(); }
    catch (e) { return res.status(500).json({ error: "could not launch Orca: " + e.message }); }
    const sid = ++SEQ;
    const s = { id: sid, file: String(b.file), type: slug, state: "watching", launchedAt: Date.now(), newGcode: null };
    SESSIONS.set(sid, s);
    const iv = setInterval(() => {
      if (Date.now() - s.launchedAt > 1800000) { s.state = "timeout"; clearInterval(iv); return; }
      if (!gdir) return;
      for (const [name, mtime] of snap()) {
        if (!before.has(name) || before.get(name) !== mtime) {
          s.state = "done"; s.newGcode = name; s.doneAt = Date.now(); clearInterval(iv);
          // The library snapshot re-walks on its own: a new file changes the
          // folder's mtime, which listLibrary checks on the next request.
          hublog("info", "models: Orca saved " + name + " (from " + s.file + ")");
          return;
        }
      }
    }, 3000);
    if (iv.unref) iv.unref();
    hublog("info", "models: opened in Orca: " + s.file);
    res.json({ ok: true, session: s });
  });
  app.get("/api/models/sessions", (req, res) => {
    const cutoff = Date.now() - 3600000;
    for (const [id, s] of SESSIONS) if (s.state !== "watching" && (s.doneAt || s.launchedAt) < cutoff) SESSIONS.delete(id);
    res.json({ sessions: [...SESSIONS.values()].sort((a, b) => b.launchedAt - a.launchedAt) });
  });
  app.post("/api/models/sessions/dismiss", (req, res) => { SESSIONS.delete(Number((req.body || {}).id)); res.json({ ok: true }); });

  // Warm the index shortly after boot; the first click should not pay for the walk.
  const t = setTimeout(() => { refresh(); }, 4000);
  if (t.unref) t.unref();

  ctx.provide("models.index", () => INDEX);
}

module.exports = { register, infoFromEntries, pickThumb, nameMatcher, split };
