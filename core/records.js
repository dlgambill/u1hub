// core/records.js — what the Hub remembers: print log, filament memory, queue, and the print-start watcher
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

module.exports = function (hub) {
const { BASE_DIR, hublog } = hub;


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


// --- print-file filament memory (v2.10) --------------------------------------
// Remembers which physical spools (loadout snapshot) a file was printed with,
// keyed on CONTENT, not filename — a partial hash of (size + first 1 MB +
// last 1 MB). Rename-proof and cross-folder-proof by construction; re-slicing
// the same project changes the bytes, so history correctly resets. Records
// live under printlog.json's reserved "__filaments" key (printlog is already
// on the never-commit list). "__filaments" is NOT a type slug: plogOf() is
// only ever called with real slugs, and the flat-map v2.8 wrap check keys on
// numeric values, which this object never has.
const FMEM_KEY = "__filaments";

function fmem() { return PRINTLOG[FMEM_KEY] || (PRINTLOG[FMEM_KEY] = {}); }

function fileContentHash(fp) {
  const st = fs.statSync(fp);
  const CH = 1024 * 1024;                       // 1 MB head + 1 MB tail
  const h = crypto.createHash("sha256");
  h.update(String(st.size));
  const fd = fs.openSync(fp, "r");
  try {
    const head = Buffer.alloc(Math.min(CH, st.size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (st.size > CH) {
      const tail = Buffer.alloc(Math.min(CH, st.size - CH));
      fs.readSync(fd, tail, 0, tail.length, st.size - tail.length);
      h.update(tail);
    }
  } finally { fs.closeSync(fd); }
  return "ph1-" + h.digest("hex").slice(0, 40);
}

// Loadout snapshot for one printer index, read straight from the state files
// on disk (slots.json / spools.json are the source of truth and are rewritten
// on every change by rfid.js — a read-only peek here keeps the modules
// decoupled). Returns [] when nothing is loaded.
function loadoutSnapshot(printerIdx) {
  let slots = {}, spools = {};
  try { slots = JSON.parse(fs.readFileSync(path.join(BASE_DIR, "slots.json"), "utf8")) || {}; } catch {}
  try { spools = (JSON.parse(fs.readFileSync(path.join(BASE_DIR, "spools.json"), "utf8")) || {}).spools || {}; } catch {}
  // slots.json keys on printer URL (survives config reorders) — mirror that.
  const p = hub.PRINTERS[printerIdx];
  const mine = (p && slots[String(p.url)]) || {};
  return Object.keys(mine).sort((a, b) => a - b).map(k => {
    const sid = (mine[k] || {}).spool_id;
    const sp = spools[sid] || {};
    return { slot: Number(k), spool_id: sid || null,
             hex: sp.hex || null, color_name: sp.color_name || null,
             brand: sp.brand || null, material_variant: sp.material_variant || null };
  }).filter(e => e.spool_id);
}

// Pending record per printer index: created when a genuine new start is
// observed, promoted into __filaments only when that print COMPLETES (a
// cancelled or failed print teaches nothing). Lost on hub restart mid-print —
// acceptable: the next successful run of the same file re-records.
const FMEM_PENDING = {};


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

function saveQueue() { try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(hub.QUEUE, null, 2)); } catch {} }

hub.QUEUE = loadQueue();

function dequeueFile(name, slug) {
  const i = hub.QUEUE.findIndex(e => e.file === name && (!slug || e.type === slug));
  if (i !== -1) { hub.QUEUE.splice(i, 1); saveQueue(); }
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
  for (let i = 0; i < hub.PRINTERS.length; i++) {
    const s = await probeState(hub.PRINTERS[i]);
    if (!s) continue;                       // unreachable: leave LAST_STATE so recovery doesn't fake a transition
    const prev = LAST_STATE[i];
    // genuine new start: a prior state exists, it wasn't already printing, and
    // it wasn't a pause. prev===undefined => first observation => boot-mid-print => skip.
    if (s.state === "printing" && prev !== undefined && prev !== "printing" && prev !== "paused") {
      const base = path.basename(s.filename || "");
      if (base) {
        const slug = hub.PRINTERS[i].type || "u1";
        plogOf(slug)[base] = Date.now(); savePrintLog();
        // v2.10 filament memory: hash the LOCAL copy of the started file and
        // snapshot this printer's loadout. Touchscreen-started files that only
        // exist printer-side simply skip (no local bytes to hash).
        try {
          const t = hub.TYPES.find(x => x.slug === slug);
          const fp = t && hub.safeFile(base, t);
          const spools = loadoutSnapshot(i);
          if (fp && fs.existsSync(fp) && spools.length) {
            FMEM_PENDING[i] = { hash: fileContentHash(fp), file: base, type: slug, spools };
            hublog("info", "fmem: watching '" + base + "' on " + (hub.PRINTERS[i].name || i) + " (" + spools.length + " spool" + (spools.length > 1 ? "s" : "") + " loaded)");
          } else { delete FMEM_PENDING[i]; }
        } catch { delete FMEM_PENDING[i]; }
      }
    }
    // Promote on completion; drop the pending record on any other exit.
    if (prev === "printing" && s.state !== "printing" && FMEM_PENDING[i]) {
      if (s.state === "complete") {
        const pnd = FMEM_PENDING[i];
        fmem()[pnd.hash] = { file: pnd.file, type: pnd.type, ts: Date.now(), spools: pnd.spools };
        savePrintLog();
        hublog("info", "fmem: recorded '" + pnd.file + "' → " + pnd.spools.length + " spool loadout");
        delete FMEM_PENDING[i];
      } else if (s.state !== "paused") {         // paused keeps the watch alive
        delete FMEM_PENDING[i];
      }
    }
    LAST_STATE[i] = s.state;
  }
}

// Interval is env-tunable so the test harness can drive a full start→complete
// lifecycle in seconds; production default stays 15 s.
setInterval(pollPrintStarts, Math.max(250, parseInt(process.env.U1HUB_POLL_MS, 10) || 15000));

pollPrintStarts();   // prime LAST_STATE at startup (won't stamp — prev is undefined)

Object.assign(hub, { dequeueFile, fileContentHash, fmem, loadoutSnapshot, plogOf, savePrintLog, saveQueue });
};
