// core/thumbs.js — gcode thumbnails
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");
const path = require("path");

module.exports = function (hub) {
const { app, fileMeta, reqTypeOf, typeBySlug, typeFolder, BASE_DIR } = hub;


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

// v2.23 PERF: extraction used to be SYNCHRONOUS - a stat plus a 256 KB read
// against the gcode share, on the event loop, per image. On production that
// was ~0.5-1 s per thumbnail during which NOTHING else was served, and a
// fresh page asks for twenty of them. Now:
//   * the read is async, so the fleet and library answers are not queued
//     behind it;
//   * the extracted PNG is kept ON DISK (BASE_DIR/thumbs/<type>/<name>.<mtime>.png,
//     a zero-byte file recording "no thumbnail in this gcode"), so a restart
//     does not re-read the share for images it already extracted;
//   * a background warmer walks the library snapshot and extracts anything
//     missing, two files at a time, so by the time a page asks the image is
//     a local-disk read. A file that changes gets a new mtime, a new entry,
//     and its stale entries are pruned on the next warm.
const THUMB_DIR = path.join(BASE_DIR, "thumbs");
const THUMB_INFLIGHT = new Map();   // key -> Promise (coalesce concurrent extractions)
const DISK_KNOWN = new Set();       // relative disk paths known to exist (avoids a stat per image)
const diskName = (name, mtimeMs) => name.replace(/[<>:"/\\|?*]/g, "_") + "." + Math.round(mtimeMs) + ".png";
const diskPathFor = (t, name, mtimeMs) => path.join(t.slug, diskName(name, mtimeMs));
try {
  for (const slug of fs.readdirSync(THUMB_DIR)) {
    try { for (const f of fs.readdirSync(path.join(THUMB_DIR, slug))) DISK_KNOWN.add(path.join(slug, f)); } catch {}
  }
} catch {}

// Extract (or recall) the thumbnail for one library file whose size and mtime
// are already known - the library snapshot has them, so no stat is needed.
function thumbFor(t, name, size, mtimeMs) {
  const key = "L:" + t.slug + ":" + name + ":" + mtimeMs;
  if (THUMB_CACHE.has(key)) return Promise.resolve(THUMB_CACHE.get(key));
  const have = THUMB_INFLIGHT.get(key);
  if (have) return have;
  const rel = diskPathFor(t, name, mtimeMs);
  const onDisk = path.join(THUMB_DIR, rel);
  const p = (async () => {
    if (DISK_KNOWN.has(rel)) {
      try { const b = await fs.promises.readFile(onDisk); const png = b.length ? b : null; thumbCachePut(key, png); return png; }
      catch { DISK_KNOWN.delete(rel); }
    }
    let png = null, fh = null;
    try {
      fh = await fs.promises.open(path.join(typeFolder(t), name), "r");
      const buf = Buffer.alloc(Math.min(262144, Math.max(0, size | 0) || 262144));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      png = extractThumb(bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf);
    } catch {}
    finally { if (fh) await fh.close().catch(() => {}); }
    thumbCachePut(key, png);
    try {
      await fs.promises.mkdir(path.dirname(onDisk), { recursive: true });
      await fs.promises.writeFile(onDisk, png || Buffer.alloc(0));
      DISK_KNOWN.add(rel);
    } catch {}
    return png;
  })().finally(() => THUMB_INFLIGHT.delete(key));
  THUMB_INFLIGHT.set(key, p);
  return p;
}

async function localThumb(name, t) {
  t = t || typeBySlug("u1");
  name = path.basename(name);
  // The library snapshot knows the file's size and mtime without touching the
  // share; only a file it has not seen (just arrived, or another type's
  // folder) costs a stat.
  let size, mtimeMs;
  const snap = hub.librarySnapshot ? hub.librarySnapshot(t) : null;
  const known = snap && snap.files.find(f => f.name === name);
  if (known) ({ size, mtime: mtimeMs } = known);
  else {
    let stat; try { stat = await fs.promises.stat(path.join(typeFolder(t), name)); } catch { return null; }
    size = stat.size; mtimeMs = stat.mtimeMs;
  }
  return thumbFor(t, name, size, mtimeMs);
}

// Background warmer: keep every library file's thumbnail on local disk.
// The library calls it each time it refreshes its snapshot (boot, then every
// 30 s), so it never adds a walk of its own and a file that just arrived has
// its image ready within a refresh. Each run also prunes disk entries for
// files that are gone or have changed. Cheap when there is nothing to do.
let THUMB_WARMING = false;
async function warmThumbs() {
  if (THUMB_WARMING || !hub.librarySnapshot) return;
  THUMB_WARMING = true;
  try {
    for (const t of (hub.TYPES || [])) {
      const snap = hub.librarySnapshot(t);
      if (!snap) continue;
      const want = new Set(snap.files.map(f => diskPathFor(t, f.name, f.mtime)));
      const todo = snap.files.filter(f => !DISK_KNOWN.has(diskPathFor(t, f.name, f.mtime)));
      for (let i = 0; i < todo.length; i += 2)
        await Promise.all(todo.slice(i, i + 2).map(f => thumbFor(t, f.name, f.size, f.mtime).catch(() => null)));
      for (const rel of [...DISK_KNOWN]) {
        if (!rel.startsWith(t.slug + path.sep) || want.has(rel)) continue;
        DISK_KNOWN.delete(rel);
        fs.promises.unlink(path.join(THUMB_DIR, rel)).catch(() => {});
      }
    }
  } finally { THUMB_WARMING = false; }
}
hub.warmThumbs = warmThumbs;

app.get("/api/thumb", async (req, res) => {
  const t = reqTypeOf(req);
  if (!t) return res.status(400).end();
  const name = path.basename(String(req.query.file || ""));
  if (!/\.gcode$/i.test(name)) return res.status(400).end();
  const png = await localThumb(name, t);
  if (!png) return res.status(404).end();
  // v2.23 PERF: the library and queue put the file's mtime in the URL (?v=),
  // so that URL names exactly one image for as long as it exists - a changed
  // file gets a new URL. Immutable lets the phone keep it for a year and never
  // spend a tunnel round trip re-checking; URLs without ?v= keep the day.
  res.set("Cache-Control", req.query.v ? "public, max-age=31536000, immutable" : "public, max-age=86400").type("png").send(png);
});

app.get("/api/pthumb", async (req, res) => {
  const p = hub.PRINTERS[+req.query.id];
  const filename = String(req.query.file || "");
  if (!p || !filename) return res.status(400).end();
  // 1) local copy of the same file — verified extraction path (printer's own type folder)
  const local = await localThumb(path.basename(filename), typeBySlug(p.type || "u1"));
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
};
