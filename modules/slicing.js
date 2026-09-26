// modules/slicing.js — in-app slicing, Phase 1 (v2.12).
//
// Engine: plain OrcaSlicer 2.4.2 CLI (upstream shipped official U1 profiles in
// 2.4.1). NOT Snapmaker Orca — its 01.10.01.50 CLI crashes on every --slice
// (unguarded wxGetApp() in expand_plate_extruders, issue filed upstream).
// Phase 1 is single-color; Phase 2 (Full Spectrum) revisits the engine choice.
//
// Pipeline:  3MF folder → [U1-ify transplant if non-native] →
//            orca-slicer --slice <plate> --outputdir <tmp> →
//            plate_*.gcode → the type's G-code folder → Queue in Dispatch.
//
// U1-ify transplant ("clean-template transplant"): Bambu-lineage 3MFs crash
// the 2.4.2 CLI (0xC0000005) even after a GUI retarget to U1 — embedded
// project presets and stale settings members survive resaves (session log12,
// 2026-08-29). The cure, validated conceptually by josuanbn/bl2u1 (idea
// credited; no code taken — their repo has an MIT/GPL license conflict):
//   1. wholesale-replace Metadata/project_settings.config with a known-clean
//      template's settings (filament_* arrays padded to 4),
//   2. patch printer_model_id in Metadata/slice_info.config when present,
//   3. remap per-object extruder ids in Metadata/model_settings.config
//      into 1..4,
//   4. strip stale embedded Metadata/machine_settings_*.config and
//      Metadata/process_settings_*.config members entirely,
//   5. every other member — geometry, painting, thumbnails, rels — passes
//      through with its ORIGINAL COMPRESSED BYTES untouched (content- and
//      byte-verbatim, and free: no 28 MB recompress).
//
// Spawn discipline (hardware-verified 2026-08-29): GUI-subsystem exes lose
// their output under cmd-/c-style redirection — child_process.spawn with
// piped stdio is the Node equivalent of Start-Process + RedirectStandard*.
// Always: separated stdout/stderr capture, exit code checked, output dir
// checked (exit 0 with no gcode is a real failure mode), per-job log kept.
// A GUI instance of Orca must not be running on the host — single-instance
// forwarding eats CLI runs; status surfaces this hint on silent failures.
//
// Config (config.json → "slicer" object, all optional):
//   exe        — slicer binary path
//                (default: C:\Program Files\OrcaSlicer\orca-slicer.exe)
//   srcFolder  — 3MF library folder (default: <baseDir>/3mf)
//   template   — clean U1 template 3MF (default: <baseDir>/slicer-template.3mf;
//                cube-u1.3mf is the verified template source)
//   plate      — plate index for --slice (default 0 = all/first)
//   timeoutMs  — per-job kill timer (default 900000 = 15 min)
//   prefixArgs — args injected BEFORE --slice (test/advanced hook: lets the
//                harness point exe at `node mock-orca-cli.js`)
//
// Jobs are in-memory and reset on restart — /api/slice/status says so
// honestly. The gcode a finished job produced is on disk and in Dispatch's
// hands; the job card is just the receipt.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

// ---- crc32 (zlib.crc32 needs Node ≥22.2; table fallback keeps pkg happy) ----
const crc32 = typeof zlib.crc32 === "function"
  ? (buf) => zlib.crc32(buf) >>> 0
  : (() => {
      const T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
      return (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    })();

// ---- Minimal zip read/write (no deps; @yao-pkg/pkg-safe) --------------------
// Read: walk the central directory (authoritative for sizes/method/crc), then
// use each LOCAL header only to find where the data starts — local name/extra
// lengths can legally differ from the central copy.
function zipRead(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (EOCD missing)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("central directory corrupt");
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const dataOff = lho + 30 + lnlen + lelen;
    entries.push({ name, method, crc, csize, usize,
      raw: buf.subarray(dataOff, dataOff + csize) });  // compressed bytes, verbatim
    off += 46 + nlen + elen + clen;
  }
  return entries;
}
function zipEntryContent(e) {
  if (e.method === 0) return Buffer.from(e.raw);
  if (e.method === 8) return zlib.inflateRawSync(e.raw);
  throw new Error("unsupported zip method " + e.method + " on " + e.name);
}
// Write: untouched entries keep their original compressed bytes + crc + method
// (true byte passthrough); replaced entries are deflated fresh.
function zipWrite(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(e.method, 8); lh.writeUInt32LE(0, 10);
    lh.writeUInt32LE(e.crc, 14); lh.writeUInt32LE(e.raw.length, 18); lh.writeUInt32LE(e.usize, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(e.method, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.raw.length, 20); ch.writeUInt32LE(e.usize, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, Buffer.from(e.raw));
    centrals.push(Buffer.concat([ch, name]));
    off += 30 + name.length + e.raw.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
function makeEntry(name, content) {
  const raw = zlib.deflateRawSync(content, { level: 6 });
  return { name, method: 8, crc: crc32(content), csize: raw.length, usize: content.length, raw };
}

// ---- U1-ify: detection + transplant -----------------------------------------
const PS = "Metadata/project_settings.config";
const MS = "Metadata/model_settings.config";
const SI = "Metadata/slice_info.config";
const STALE_RE = /^Metadata\/(machine_settings_|process_settings_).*\.config$/;

// Why is this file suspect? Every reason is a string the UI can show — the
// transplant is never silent about why it fired.
function detect3mf(entries) {
  const reasons = [];
  const byName = new Map(entries.map(e => [e.name, e]));
  const psE = byName.get(PS);
  if (!psE) return { native: false, reasons: ["no project_settings.config (not a project 3MF)"], sliceable: false };
  let ps = null;
  try { ps = JSON.parse(zipEntryContent(psE).toString("utf8")); }
  catch { return { native: false, reasons: ["project_settings.config is not valid JSON"], sliceable: false }; }
  if (String(ps.printer_model || "") !== "Snapmaker U1")
    reasons.push("printer_model is '" + (ps.printer_model || "(unset)") + "', not Snapmaker U1");
  // Embedded project presets — the poison that survives a GUI retarget
  // (filament_settings_id like "Generic PLA(ag.3mf)").
  const idKeys = ["printer_settings_id", "print_settings_id"];
  for (const k of idKeys)
    if (/\.3mf\)/.test(String(ps[k] || ""))) reasons.push(k + " references an embedded project preset");
  for (const v of Array.isArray(ps.filament_settings_id) ? ps.filament_settings_id : [])
    if (/\.3mf\)/.test(String(v || ""))) { reasons.push("filament_settings_id references embedded project presets"); break; }
  for (const e of entries)
    if (STALE_RE.test(e.name)) { reasons.push("stale embedded machine/process settings members present"); break; }
  const msE = byName.get(MS);
  if (msE) {
    const xml = zipEntryContent(msE).toString("utf8");
    for (const m of xml.matchAll(/<metadata key="extruder" value="(\d+)"\s*\/>/g)) {
      const n = +m[1];
      if (n < 1 || n > 4) { reasons.push("object extruder id " + n + " outside 1..4"); break; }
    }
  }
  return { native: reasons.length === 0, reasons, sliceable: true };
}

// Pad every filament_* array in the template settings to exactly 4 entries
// (repeat the last) — the U1 CLI path indexes 4 physical filaments.
function padFilamentArrays(ps) {
  for (const k of Object.keys(ps)) {
    if (!k.startsWith("filament_") || !Array.isArray(ps[k])) continue;
    const a = ps[k];
    if (a.length > 0 && a.length < 4) while (a.length < 4) a.push(a[a.length - 1]);
  }
  return ps;
}

// The transplant. Pure function: bytes in, bytes out + a change manifest.
// Geometry/painting/thumbnails pass through with original compressed bytes.
function u1ify(srcBuf, tplBuf) {
  const src = zipRead(srcBuf);
  const tpl = zipRead(tplBuf);
  const tplPsE = tpl.find(e => e.name === PS);
  if (!tplPsE) throw new Error("template 3MF has no project_settings.config");
  const tplPs = padFilamentArrays(JSON.parse(zipEntryContent(tplPsE).toString("utf8")));
  const tplPsBytes = Buffer.from(JSON.stringify(tplPs, null, 4), "utf8");
  const tplModelId = String(tplPs.printer_model || "Snapmaker U1");

  const changed = [];
  const out = [];
  for (const e of src) {
    if (STALE_RE.test(e.name)) { changed.push("stripped " + e.name); continue; }
    if (e.name === PS) { out.push(makeEntry(PS, tplPsBytes)); changed.push("replaced project_settings.config with template settings"); continue; }
    if (e.name === SI) {
      const xml = zipEntryContent(e).toString("utf8");
      if (/key="printer_model_id"/.test(xml)) {
        const patched = xml.replace(/(<header_item key="printer_model_id" value=")[^"]*(")/g, "$1" + tplModelId + "$2")
                           .replace(/(<metadata key="printer_model_id" value=")[^"]*(")/g, "$1" + tplModelId + "$2");
        if (patched !== xml) { out.push(makeEntry(SI, Buffer.from(patched, "utf8"))); changed.push("patched printer_model_id in slice_info.config"); continue; }
      }
      out.push(e); continue;
    }
    if (e.name === MS) {
      const xml = zipEntryContent(e).toString("utf8");
      const patched = xml.replace(/(<metadata key="extruder" value=")(\d+)("\s*\/>)/g,
        (all, a, n, b) => (+n >= 1 && +n <= 4) ? all : a + "1" + b);
      if (patched !== xml) { out.push(makeEntry(MS, Buffer.from(patched, "utf8"))); changed.push("remapped out-of-range object extruder ids to 1"); continue; }
      out.push(e); continue;
    }
    out.push(e);  // byte-verbatim passthrough (geometry, painting, thumbnails, rels)
  }
  return { buffer: zipWrite(out), changed };
}

// ---- Clone instances (v2.12 tranche 4 probe) --------------------------------
// The 2.4.2 CLI's --repetitions only serves the loose-STL load path — it
// errors out on project 3MFs (hardware-verified 2026-08-29, exit -2 with
// "CLI::run found error"). --arrange 1 DOES work on projects (exit 0, same
// session). So cloning is zip surgery: duplicate every <item> in the build
// section of 3D/3dmodel.model (fresh p:UUID, grid-offset transform) plus the
// matching <model_instance> and <assemble_item> blocks in
// Metadata/model_settings.config, then let --arrange 1 do real placement.
// Offsets here are only a de-overlap seed for arrange — 40 mm grid steps.
// Geometry members are untouched (components reference the same object).
function uuid4() {
  const h = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
  return h() + h() + "-" + h() + "-4" + h().slice(1) + "-a" + h().slice(1) + "-" + h() + h() + h();
}
function offsetTransform(tf, dx, dy) {
  const p = tf.trim().split(/\s+/).map(Number);
  if (p.length !== 12 || p.some(isNaN)) return tf;
  p[9] += dx; p[10] += dy;
  return p.map(n => Number.isInteger(n) ? String(n) : String(n)).join(" ");
}
function cloneInstances(srcBuf, copies) {
  copies = Math.max(1, Math.min(50, Math.floor(copies)));
  if (copies === 1) return { buffer: srcBuf, changed: [] };
  const entries = zipRead(srcBuf);
  const MODEL = "3D/3dmodel.model";
  const mi = entries.findIndex(e => e.name === MODEL);
  const si = entries.findIndex(e => e.name === MS);
  if (mi < 0) throw new Error("no 3D/3dmodel.model in 3MF");
  let model = zipEntryContent(entries[mi]).toString("utf8");
  const grid = k => [40 * (k % 3), 40 * Math.floor(k / 3)];  // k = 1..copies-1

  // 1) build items — every printable instance gets copies-1 siblings.
  const items = [...model.matchAll(/<item\b[^>]*\/>/g)].map(m => m[0]);
  if (!items.length) throw new Error("no <item> instances in build section");
  const additions = [];
  for (const it of items)
    for (let k = 1; k < copies; k++) {
      const [dx, dy] = grid(k);
      let c = it.replace(/p:UUID="[^"]*"/, 'p:UUID="' + uuid4() + '"');
      c = c.replace(/transform="([^"]*)"/, (_, tf) => 'transform="' + offsetTransform(tf, dx, dy) + '"');
      additions.push(c);
    }
  model = model.replace(/<\/build>/, " " + additions.join("\n  ") + "\n </build>");
  const modelBytes = Buffer.from(model, "utf8");
  entries[mi] = makeEntry(MODEL, modelBytes);

  // 2) model_settings — mirror the duplication so the project stays coherent
  //    (instance_id increments per object; identify_id stays unique).
  if (si >= 0) {
    let ms = zipEntryContent(entries[si]).toString("utf8");
    let maxIdentify = 0;
    for (const m of ms.matchAll(/key="identify_id" value="(\d+)"/g)) maxIdentify = Math.max(maxIdentify, +m[1]);
    const instBlocks = [...ms.matchAll(/<model_instance>[\s\S]*?<\/model_instance>/g)].map(m => m[0]);
    const instAdd = [];
    for (const blk of instBlocks)
      for (let k = 1; k < copies; k++)
        instAdd.push(blk
          .replace(/(key="instance_id" value=")(\d+)(")/, (_, a, n, b) => a + (+n + k) + b)
          .replace(/(key="identify_id" value=")(\d+)(")/, (_, a) => a + (++maxIdentify) + '"'));
    if (instAdd.length) ms = ms.replace(/<\/plate>/, "    " + instAdd.join("\n    ") + "\n  </plate>");
    const asmItems = [...ms.matchAll(/<assemble_item\b[^>]*\/>/g)].map(m => m[0]);
    const asmAdd = [];
    for (const it of asmItems)
      for (let k = 1; k < copies; k++) {
        const [dx, dy] = grid(k);
        asmAdd.push(it
          .replace(/(instance_id=")(\d+)(")/, (_, a, n, b) => a + (+n + k) + b)
          .replace(/transform="([^"]*)"/, (_, tf) => 'transform="' + offsetTransform(tf, dx, dy) + '"'));
      }
    if (asmAdd.length) ms = ms.replace(/<\/assemble>/, "   " + asmAdd.join("\n   ") + "\n  </assemble>");
    entries[si] = makeEntry(MS, Buffer.from(ms, "utf8"));
  }
  return { buffer: zipWrite(entries),
    changed: ["cloned " + items.length + " instance(s) ×" + copies + " (arrange required for placement)"] };
}

// ---- exit-code translation (Windows realities, plainly stated) --------------
function explainExit(code) {
  if (code === -1073741819 || code === 3221225477 || code === 0xC0000005)
    return "access violation (0xC0000005) — the CLI crashed on this project; a U1-ify transplant usually cures Bambu-lineage files";
  return null;
}

// ---- module -----------------------------------------------------------------
function register(ctx) {
  const { app, hublog } = ctx;

  const scfg = () => {
    const c = (ctx.cfg && typeof ctx.cfg.slicer === "object" && ctx.cfg.slicer) || {};
    return {
      exe: c.exe || "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe",
      srcFolder: path.resolve(ctx.baseDir, c.srcFolder || "./3mf"),
      template: path.resolve(ctx.baseDir, c.template || "./slicer-template.3mf"),
      plate: Number.isInteger(c.plate) ? c.plate : 0,
      timeoutMs: Number.isInteger(c.timeoutMs) ? c.timeoutMs : 900000,
      prefixArgs: Array.isArray(c.prefixArgs) ? c.prefixArgs : []
    };
  };
  // Auto-create only the DEFAULT library folder. A user-configured path
  // (X:\3mf-sorted) is never silently created — same ethos as type folders:
  // if it's missing, status says so and the fix is the user's to make.
  if (!((ctx.cfg || {}).slicer || {}).srcFolder) { try { fs.mkdirSync(scfg().srcFolder, { recursive: true }); } catch {} }

  // Job book — persisted to slicejobs.json (v2.12 tranche 5) so history
  // survives restarts. STATE FILE: belongs in .gitignore with the rest
  // (config/spools/queue/…), never committed. Atomic temp+rename, same
  // discipline as dispatch.json. A job caught mid-flight by a restart is
  // marked error honestly on load — we cannot know what the CLI did.
  const JOBS_PATH = path.join(ctx.baseDir, "slicejobs.json");
  const JOBS = [];
  let SEQ = 0, RUNNING = false;
  try {
    const saved = JSON.parse(fs.readFileSync(JOBS_PATH, "utf8"));
    for (const j of (Array.isArray(saved.jobs) ? saved.jobs : [])) {
      if (!["done", "error"].includes(j.state)) {
        j.state = "error"; j.error = "interrupted by Hub restart mid-" + (j.state || "run"); j.endedAt = j.endedAt || Date.now();
      }
      JOBS.push(j); SEQ = Math.max(SEQ, j.id || 0);
    }
  } catch {}
  let saveTimer = null;
  function saveJobs() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const tmp = JOBS_PATH + ".tmp";
        // logs are trimmed for the book — the live tail is enough forensics
        fs.writeFileSync(tmp, JSON.stringify({ jobs: JOBS.map(j => ({ ...j, log: (j.log || "").slice(-4000) })) }));
        fs.renameSync(tmp, JOBS_PATH);
      } catch {}
    }, 300);
  }
  const LOG_CAP = 65536;
  // Setting knobs the enqueue route accepts. layer_height and
  // sparse_infill_density are hardware-verified as CLI flags (2026-08-29
  // probe P1); the rest ride the identical mechanism and are proven per-job
  // by the applied-echo — a silently ignored knob is reported, never trusted.
  const SETTING_DEFS = {
    layer_height:            { kind: "float", min: 0.04, max: 0.6 },
    sparse_infill_density:   { kind: "percent", min: 0, max: 100 },
    enable_support:          { kind: "bool" },
    wall_loops:              { kind: "int", min: 1, max: 12 },
    // v2.12 tranche 5 — same flag mechanism; enum spellings follow Orca 2.4.2
    // conventions and every job's applied-echo (or an honest CLI error card)
    // is the per-run proof. A wrong value fails loudly, never silently.
    top_shell_layers:        { kind: "int", min: 0, max: 20 },
    bottom_shell_layers:     { kind: "int", min: 0, max: 20 },
    sparse_infill_pattern:   { kind: "enum", values: ["grid", "gyroid", "cubic", "honeycomb", "lightning", "zig-zag", "triangles", "adaptivecubic"] },
    brim_type:               { kind: "enum", values: ["no_brim", "outer_only", "inner_only", "outer_and_inner", "auto_brim"] }
  };
  function validateSettings(raw) {
    if (raw == null) return { settings: {} };
    if (typeof raw !== "object") return { error: "settings must be an object" };
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const d = SETTING_DEFS[k];
      if (!d) return { error: "unknown setting '" + k + "' (allowed: " + Object.keys(SETTING_DEFS).join(", ") + ")" };
      if (d.kind === "bool") { out[k] = (v === true || v === 1 || v === "1") ? "1" : "0"; continue; }
      if (d.kind === "enum") {
        if (!d.values.includes(String(v))) return { error: k + " must be one of: " + d.values.join(", ") };
        out[k] = String(v); continue;
      }
      const n = parseFloat(String(v).replace(/%$/, ""));
      if (!isFinite(n) || n < d.min || n > d.max)
        return { error: k + " must be between " + d.min + " and " + d.max };
      if (d.kind === "int" && !Number.isInteger(n)) return { error: k + " must be an integer" };
      out[k] = d.kind === "percent" ? n + "%" : String(n);
    }
    return { settings: out };
  }

  const pub = j => ({ id: j.id, file: j.file, type: j.type, state: j.state,
    transplant: j.transplant, transplanted: j.transplanted || false,
    copies: j.copies || 1, settings: j.settings || {}, applied: j.applied || null,
    detectedReasons: j.detectedReasons || [], changed: j.changed || [],
    queuedAt: j.queuedAt, startedAt: j.startedAt || null, endedAt: j.endedAt || null,
    exitCode: j.exitCode ?? null, error: j.error || null, hint: j.hint || null,
    gcodeName: j.gcodeName || null, gcodeNames: j.gcodeNames || [], plates: j.plates || 1, estMinutes: j.estMinutes ?? null,
    logTail: (j.log || "").slice(-4000) });

  // Safe path inside the 3MF library only (one level of subfolders welcome —
  // X:\3mf-sorted is organized that way).
  function safe3mf(rel) {
    const c = scfg();
    const p = path.resolve(c.srcFolder, String(rel || ""));
    if (!p.startsWith(c.srcFolder + path.sep) && p !== c.srcFolder) return null;
    if (!p.toLowerCase().endsWith(".3mf")) return null;
    return p;
  }
  function list3mf() {
    const c = scfg(), out = [];
    const walk = (dir, rel, depth) => {
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        if (it.name.startsWith(".")) continue;
        if (it.isDirectory()) { if (depth < 2) walk(path.join(dir, it.name), rel + it.name + "/", depth + 1); continue; }
        if (!it.name.toLowerCase().endsWith(".3mf")) continue;
        let size = 0, mtime = 0;
        try { const st = fs.statSync(path.join(dir, it.name)); size = st.size; mtime = st.mtimeMs; } catch {}
        out.push({ file: rel + it.name, size, mtime });
        if (out.length >= 500) return;
      }
    };
    walk(c.srcFolder, "", 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  function nonColliding(dir, base) {
    let name = base + ".gcode", n = 2;
    while (fs.existsSync(path.join(dir, name))) name = base + "-" + (n++) + ".gcode";
    return name;
  }

  async function runJob(j) {
    const c = scfg();
    j.state = "preparing"; j.startedAt = Date.now();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1slice-"));
    const outDir = path.join(tmp, "out"); fs.mkdirSync(outDir);
    try {
      const srcPath = safe3mf(j.file);
      if (!srcPath || !fs.existsSync(srcPath)) throw new Error("3MF not found in library: " + j.file);
      const srcBuf = fs.readFileSync(srcPath);

      // Buffer pipeline: transplant → clone → one write. Each stage records
      // what it did; nothing is written unless something changed.
      let workBuf = srcBuf, modified = false;
      const det = detect3mf(zipRead(srcBuf));
      j.detectedReasons = det.reasons;
      const want = j.transplant === "always" || (j.transplant === "auto" && !det.native);
      if (want) {
        if (!fs.existsSync(c.template))
          throw new Error("transplant needed (" + (det.reasons[0] || "forced") + ") but template missing at " + c.template +
                          " — copy a known-clean U1 project (cube-u1.3mf) there");
        const t = u1ify(workBuf, fs.readFileSync(c.template));
        j.transplanted = true; j.changed = t.changed;
        workBuf = t.buffer; modified = true;
      }
      if (j.copies > 1) {
        const cl = cloneInstances(workBuf, j.copies);
        j.changed = [...(j.changed || []), ...cl.changed];
        workBuf = cl.buffer; modified = true;
      }
      let slicePath = srcPath;
      if (modified) { slicePath = path.join(tmp, "prepared.3mf"); fs.writeFileSync(slicePath, workBuf); }

      // Slice. spawn = Start-Process + RedirectStandard* — never a shell.
      // Per-setting flags ride the CLI's documented priority: command line >
      // loaded settings > 3MF. Clones REQUIRE --arrange 1 (the seeded grid
      // offsets are only a de-overlap hint; hardware-verified 2026-08-29).
      j.state = "slicing";
      const setFlags = [];
      for (const [k, v] of Object.entries(j.settings || {}))
        setFlags.push("--" + k.replace(/_/g, "-"), String(v));
      const args = [...c.prefixArgs, "--slice", String(c.plate), "--debug", "2",
        ...setFlags, ...(j.copies > 1 ? ["--arrange", "1"] : []),
        "--outputdir", outDir, slicePath];
      const code = await new Promise((resolve, reject) => {
        let ch;
        try { ch = spawn(c.exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
        catch (e) { return reject(new Error("could not start slicer: " + e.message)); }
        const feed = d => { j.log = ((j.log || "") + d).slice(-LOG_CAP); };
        ch.stdout.on("data", feed); ch.stderr.on("data", feed);
        const killer = setTimeout(() => { try { ch.kill("SIGKILL"); } catch {} j.timedOut = true; }, c.timeoutMs);
        ch.on("error", e => { clearTimeout(killer); reject(new Error("slicer failed to run: " + e.message)); });
        ch.on("exit", codeOrNull => { clearTimeout(killer); resolve(codeOrNull); });
      });
      j.exitCode = code;
      if (j.timedOut) throw new Error("slicer killed after " + Math.round(c.timeoutMs / 60000) + " min timeout");
      if (code !== 0) {
        const why = explainExit(code);
        throw new Error("slicer exited " + code + (why ? " — " + why : "") +
                        ((j.log || "").trim() ? "" : " (no output captured — hard crash before any error path)"));
      }
      const gc = fs.readdirSync(outDir).filter(f => f.toLowerCase().endsWith(".gcode"));
      if (!gc.length) {
        j.hint = "exit 0 with no gcode usually means a GUI instance of the slicer swallowed the run (single-instance forwarding) — close the GUI and retry";
        throw new Error("slicer exited 0 but produced no gcode");
      }
      // --slice 0 slices ALL plates. When arrange can't fit every clone on
      // one bed it spills to plate 2, 3, … — every plate is a real print and
      // every plate ships. (Hardware-found 2026-08-29: a ×2 of a 150×175 mm
      // model produced two plates and the Hub silently kept only one.)
      gc.sort((a, b) => {
        const n = f => { const m = /plate_(\d+)/i.exec(f); return m ? +m[1] : 0; };
        return n(a) - n(b);
      });
      j.state = "moving";
      const destDir = ctx.gcodeFolderFor(j.type);
      const base = path.basename(j.file, path.extname(j.file)).replace(/[\\/:*?"<>|]/g, "_");
      j.gcodeNames = [];
      for (let i = 0; i < gc.length; i++) {
        const name = nonColliding(destDir, gc.length === 1 ? base : base + "-p" + (i + 1));
        fs.copyFileSync(path.join(outDir, gc[i]), path.join(destDir, name));
        j.gcodeNames.push(name);
      }
      j.gcodeName = j.gcodeNames[0];
      if (gc.length > 1) {
        j.plates = gc.length;
        j.changed = [...(j.changed || []),
          "arrange spilled to " + gc.length + " plates (not everything fits one bed) — each plate is its own gcode"];
      }

      const info = ctx.fileInfo(j.gcodeName, j.type);
      j.estMinutes = info && info.estMinutes != null ? info.estMinutes : null;

      // Applied-echo: the gcode's config tail is the ground truth for what
      // the slicer actually used. Every requested setting is checked against
      // it — a knob the CLI silently ignored shows up as ok:false on the job
      // card instead of being trusted. This is what lets future knobs be
      // added without a fresh hardware probe each time.
      if (j.settings && Object.keys(j.settings).length) {
        j.applied = {};
        let tail = "";
        try {
          const gp = path.join(destDir, j.gcodeName);
          const st = fs.statSync(gp); const CH = Math.min(262144, st.size);
          const fd = fs.openSync(gp, "r"); const b = Buffer.alloc(CH);
          fs.readSync(fd, b, 0, CH, st.size - CH); fs.closeSync(fd);
          tail = b.toString("utf8");
        } catch {}
        for (const [k, v] of Object.entries(j.settings)) {
          const m = new RegExp("^; " + k + " = (.*)$", "m").exec(tail);
          const got = m ? m[1].trim() : null;
          const norm = s => String(s).replace(/%$/, "").trim();
          const okv = got !== null && (norm(got) === norm(v) ||
            (isFinite(parseFloat(norm(got))) && isFinite(parseFloat(norm(v))) &&
             Math.abs(parseFloat(norm(got)) - parseFloat(norm(v))) < 1e-6));
          j.applied[k] = { requested: String(v), applied: got, ok: okv };
        }
      }
      j.state = "done"; j.endedAt = Date.now(); saveJobs();
      hublog("info", "slice done: " + j.file + " → " + j.gcodeName + (j.transplanted ? " (transplanted)" : ""));
    } catch (e) {
      j.state = "error"; j.error = e.message; j.endedAt = Date.now(); saveJobs();
      hublog("error", "slice failed: " + j.file + " — " + e.message);
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  async function pump() {
    if (RUNNING) return;
    RUNNING = true;
    try {
      for (;;) {
        const j = JOBS.find(x => x.state === "queued");
        if (!j) break;
        await runJob(j);          // one at a time — the CLI is heavy and the
      }                           // host is also running nine printers' Hub
    } finally { RUNNING = false; }
  }

  // ---- routes ---------------------------------------------------------------
  app.get("/api/slice/status", (req, res) => {
    const c = scfg();
    res.json({
      engine: "orca-cli",
      exe: c.exe, exeFound: fs.existsSync(c.exe),
      template: c.template, templateFound: fs.existsSync(c.template),
      srcFolder: c.srcFolder, srcFolderFound: fs.existsSync(c.srcFolder),
      plate: c.plate,
      running: RUNNING, queued: JOBS.filter(j => j.state === "queued").length,
      note: "job history persists in slicejobs.json; a job interrupted by a restart is marked error"
    });
  });

  // UI-editable settings (v2.12, Danny's ask after a round of PowerShell JSON
  // surgery). Partial update; known keys only; empty string reverts a key to
  // its default. Applies LIVE — scfg() reads ctx.cfg fresh on every use, so
  // no restart semantics to be honest about. Paths are validated for shape,
  // and existence is reported by status rather than blocking the save: a
  // network drive being offline right now is not a reason to refuse the
  // setting that will be right when it mounts.
  app.post("/api/slice/config", (req, res) => {
    const b = req.body || {};
    const cur = (ctx.cfg && typeof ctx.cfg.slicer === "object" && ctx.cfg.slicer) || {};
    const next = { ...cur };
    for (const k of ["srcFolder", "exe", "template"]) {
      if (!(k in b)) continue;
      if (typeof b[k] !== "string") return res.status(400).json({ error: k + " must be a string" });
      const v = b[k].trim();
      if (v === "") delete next[k];
      else if (/[\0\n\r]/.test(v)) return res.status(400).json({ error: k + " contains invalid characters" });
      else next[k] = v;
    }
    if ("plate" in b) {
      const n = Number(b.plate);
      if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: "plate must be a non-negative integer" });
      next.plate = n;
    }
    if ("timeoutMs" in b) {
      const n = Number(b.timeoutMs);
      if (!Number.isInteger(n) || n < 10000) return res.status(400).json({ error: "timeoutMs must be an integer ≥ 10000" });
      next.timeoutMs = n;
    }
    ctx.cfg.slicer = next;
    ctx.saveConfig();
    hublog("info", "slicing config updated: " + Object.keys(b).filter(k => ["srcFolder","exe","template","plate","timeoutMs"].includes(k)).join(", "));
    const c = scfg();
    res.json({ ok: true, exe: c.exe, exeFound: fs.existsSync(c.exe),
      template: c.template, templateFound: fs.existsSync(c.template),
      srcFolder: c.srcFolder, srcFolderFound: fs.existsSync(c.srcFolder), plate: c.plate });
  });

  app.get("/api/slice/files", (req, res) => res.json({ files: list3mf() }));

  app.get("/api/slice/jobs", (req, res) =>
    res.json({ jobs: JOBS.slice(-50).reverse().map(pub) }));

  app.post("/api/slice", (req, res) => {
    const c = scfg();
    if (!fs.existsSync(c.exe))
      return res.status(503).json({ error: "slicer not found at " + c.exe + " — set config.json → slicer.exe" });
    const file = String((req.body || {}).file || "");
    if (!safe3mf(file)) return res.status(400).json({ error: "file must be a .3mf inside the 3MF library" });
    if (!fs.existsSync(safe3mf(file))) return res.status(404).json({ error: "not in library: " + file });
    const type = String((req.body || {}).type || "u1");
    const transplant = ["auto", "always", "never"].includes((req.body || {}).transplant) ? req.body.transplant : "auto";
    const copies = Math.max(1, Math.min(50, parseInt((req.body || {}).copies, 10) || 1));
    const vs = validateSettings((req.body || {}).settings);
    if (vs.error) return res.status(400).json({ error: vs.error });
    const j = { id: ++SEQ, file, type, transplant, copies, settings: vs.settings, state: "queued", queuedAt: Date.now(), log: "" };
    JOBS.push(j);
    if (JOBS.length > 200) JOBS.splice(0, JOBS.length - 200);
    saveJobs();
    pump();
    res.json({ ok: true, job: pub(j) });
  });

  // Plate thumbnail straight out of the 3MF (Metadata/plate_1.png). Tiny
  // LRU keyed on path+mtime — zips on the SMB share are 10+ MB and the file
  // list would otherwise re-read them on every scroll.
  const THUMBS = new Map();
  app.get("/api/slice/thumb", (req, res) => {
    const p = safe3mf(req.query.file);
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    try {
      const key = p + ":" + fs.statSync(p).mtimeMs;
      if (!THUMBS.has(key)) {
        const e = zipRead(fs.readFileSync(p)).find(x => /^Metadata\/plate_\d+_small\.png$/.test(x.name))
               || zipRead(fs.readFileSync(p)).find(x => /^Metadata\/plate_\d+\.png$/.test(x.name));
        if (!e) return res.status(404).end();
        THUMBS.set(key, zipEntryContent(e));
        if (THUMBS.size > 30) THUMBS.delete(THUMBS.keys().next().value);
      }
      res.type("png").send(THUMBS.get(key));
    } catch { res.status(422).end(); }
  });

  // Re-slice: new job, same recipe. The old card stays — history is history.
  app.post("/api/slice/again", (req, res) => {
    const src = JOBS.find(x => x.id === +((req.body || {}).id));
    if (!src) return res.status(404).json({ error: "no such job" });
    const j = { id: ++SEQ, file: src.file, type: src.type, transplant: src.transplant,
      copies: src.copies || 1, settings: { ...(src.settings || {}) }, state: "queued", queuedAt: Date.now(), log: "" };
    JOBS.push(j); saveJobs(); pump();
    res.json({ ok: true, job: pub(j) });
  });

  // Clear finished/failed cards. Running and queued jobs are untouched.
  app.post("/api/slice/clear", (req, res) => {
    const before = JOBS.length;
    for (let i = JOBS.length - 1; i >= 0; i--)
      if (["done", "error"].includes(JOBS[i].state)) JOBS.splice(i, 1);
    saveJobs();
    res.json({ ok: true, removed: before - JOBS.length });
  });

  // Dry-run inspection: what would the transplant do to this file?
  app.get("/api/slice/inspect", (req, res) => {
    const p = safe3mf(req.query.file);
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not in library" });
    try { res.json({ file: req.query.file, ...detect3mf(zipRead(fs.readFileSync(p))) }); }
    catch (e) { res.status(422).json({ error: e.message }); }
  });

  // Open in Orca: launch Snapmaker Orca GUI with the requested 3MF already
  // loaded. Hardware-verified 2026-08-29: spawn with a single file-path
  // argument opens the file on the plate in GUI mode.
  // Config: slicer.orcaExe (default: C:\Program Files\Snapmaker_Orca\snapmaker-orca.exe)
  // After launching, the Hub polls the gcode folder for new/changed files
  // for up to 30 minutes so the UI can surface a "Queue in Dispatch" card
  // the moment the user saves from Orca. The poll stops on any new file.
  const orcaExe = () => {
    const c = (ctx.cfg && typeof ctx.cfg.slicer === "object" && ctx.cfg.slicer) || {};
    return c.orcaExe || "C:\\Program Files\\Snapmaker_Orca\\snapmaker-orca.exe";
  };

  // Track active "waiting for gcode" sessions keyed by session id.
  const ORCA_SESSIONS = new Map();

  app.post("/api/slice/open-in-orca", (req, res) => {
    const file = String((req.body || {}).file || "");
    const p = safe3mf(file);
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: "not in library: " + file });
    const exe = orcaExe();
    if (!fs.existsSync(exe)) return res.status(503).json({ error: "Snapmaker Orca not found at " + exe + " — set config.json → slicer.orcaExe" });

    // Snapshot gcode folder state before launch so we can detect new files.
    const gdir = ctx.gcodeFolderFor((req.body || {}).type || "u1");
    const snapFiles = () => {
      try { return new Map(fs.readdirSync(gdir).filter(f => f.toLowerCase().endsWith(".gcode")).map(f => {
        const st = fs.statSync(path.join(gdir, f)); return [f, st.mtimeMs];
      })); } catch { return new Map(); }
    };
    const before = snapFiles();

    try {
      spawn(exe, [p], { detached: true, stdio: "ignore" }).unref();
    } catch (e) {
      return res.status(500).json({ error: "could not launch Orca: " + e.message });
    }

    const sid = ++SEQ;
    const session = { id: sid, file, state: "watching", launchedAt: Date.now(), newGcode: null };
    ORCA_SESSIONS.set(sid, session);

    // Poll for new/modified gcode, max 30 min.
    const POLL_MS = 3000, MAX_MS = 1800000;
    const iv = setInterval(() => {
      if (Date.now() - session.launchedAt > MAX_MS) {
        session.state = "timeout"; clearInterval(iv); ORCA_SESSIONS.delete(sid); return;
      }
      const after = snapFiles();
      for (const [name, mtime] of after) {
        if (!before.has(name) || before.get(name) !== mtime) {
          session.state = "done"; session.newGcode = name;
          clearInterval(iv);
          hublog("info", "open-in-orca: new gcode detected: " + name);
          return;
        }
      }
    }, POLL_MS);

    hublog("info", "open-in-orca: launched Orca with " + file);
    res.json({ ok: true, sessionId: sid, file, gcodeFolderHint: gdir });
  });

  app.get("/api/slice/orca-session", (req, res) => {
    const sid = +req.query.id;
    const s = ORCA_SESSIONS.get(sid);
    if (!s) return res.status(404).json({ error: "no such session" });
    res.json(s);
  });

  hublog("info", "slicing: exe " + (fs.existsSync(scfg().exe) ? "found" : "NOT FOUND") +
                 ", template " + (fs.existsSync(scfg().template) ? "found" : "NOT FOUND"));
}

module.exports = { register, u1ify, detect3mf, cloneInstances, zipRead, zipWrite, zipEntryContent, padFilamentArrays, makeEntry };
