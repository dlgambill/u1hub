// modules/tuning.js - "Open in Orca with these settings" (v2.42).
//
// The 3MF settings suggester (advisor.js) answers with a table of Orca keys
// and values. This turns that table into a 3MF Orca opens with those values
// already set, WITHOUT touching the original: the route (models.js) writes
// the result to a scratch copy and opens that.
//
// The guardrail is the point of this file. An AI answer never writes a key
// that is not listed below, and every value is checked against the type and
// range a person would accept for a U1 before it goes in. Anything that fails
// is reported as "not applied" with the reason - never guessed, never
// clamped into something the model did not say.
//
// Process keys are one value for the whole project. Filament keys are one
// value per slot; a single suggested temperature is only written when every
// slot holds the same material, because one number for a PLA + PETG project
// would be wrong for one of them.
//
// Orca shows a project's own values as "modified" through
// different_settings_to_system: [process, filament 1..4, printer], each a
// ";"-joined key list. Every applied key is added there, so the changes show
// up in Orca as edits you can see and revert one by one.
//
// Pure: bytes in, bytes and a report out.
"use strict";

const { zipRead, zipWrite, zipEntryContent, makeEntry } = require("./slicing.js");

const PS = "Metadata/project_settings.config";
const SLOTS = 4;

const num = (lo, hi, { int = false, unit = "" } = {}) => ({ kind: "num", lo, hi, int, unit });
const pct = (lo, hi) => ({ kind: "pct", lo, hi });
const bool = () => ({ kind: "bool" });
const oneOf = (...vals) => ({ kind: "enum", vals });

// key -> rule. "filament: true" = a per-slot array.
const TUNE = {
  layer_height:               num(0.04, 0.32),
  initial_layer_print_height: num(0.08, 0.4),
  wall_loops:                 num(1, 10, { int: true }),
  top_shell_layers:           num(0, 20, { int: true }),
  bottom_shell_layers:        num(0, 20, { int: true }),
  sparse_infill_density:      pct(0, 100),
  sparse_infill_pattern:      oneOf("grid", "gyroid", "cubic", "triangles", "tri-hexagon", "honeycomb", "adaptivecubic", "lightning", "line", "zig-zag", "crosshatch", "supportcubic", "alignedrectilinear", "3dhoneycomb", "hilbertcurve", "archimedeanchords", "octagramspiral", "concentric"),
  enable_support:             bool(),
  support_type:               oneOf("normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"),
  support_threshold_angle:    num(0, 90, { int: true }),
  support_on_build_plate_only: bool(),
  brim_type:                  oneOf("auto_brim", "brim_ears", "outer_only", "inner_only", "outer_and_inner", "no_brim"),
  brim_width:                 num(0, 20),
  skirt_loops:                num(0, 10, { int: true }),
  enable_prime_tower:         bool(),
  seam_position:              oneOf("nearest", "aligned", "back", "random"),
  ironing_type:               oneOf("no ironing", "top", "topmost", "solid"),
  only_one_wall_top:          bool(),
  detect_thin_wall:           bool(),
  elefant_foot_compensation:  num(0, 1),
  outer_wall_speed:           num(10, 500),
  inner_wall_speed:           num(10, 600),
  sparse_infill_speed:        num(10, 600),
  initial_layer_speed:        num(5, 200),
  nozzle_temperature:               Object.assign(num(170, 320, { int: true }), { filament: true }),
  nozzle_temperature_initial_layer: Object.assign(num(170, 320, { int: true }), { filament: true }),
  hot_plate_temp:             Object.assign(num(0, 120, { int: true }), { filament: true }),
  textured_plate_temp:        Object.assign(num(0, 120, { int: true }), { filament: true }),
  cool_plate_temp:            Object.assign(num(0, 120, { int: true }), { filament: true }),
  fan_min_speed:              Object.assign(num(0, 100, { int: true }), { filament: true }),
  fan_max_speed:              Object.assign(num(0, 100, { int: true }), { filament: true }),
  slow_down_layer_time:       Object.assign(num(0, 60, { int: true }), { filament: true })
};

// Words people (and models) use for on/off.
const ON = /^(1|true|yes|on|enabled?|everywhere)$/i, OFF = /^(0|false|no|off|disabled?|none)$/i;
// Labels for enum values, so "Tree (auto)" or "Outer brim only" still land.
const ENUM_ALIAS = {
  support_type: { "tree": "tree(auto)", "tree auto": "tree(auto)", "normal": "normal(auto)", "normal auto": "normal(auto)", "tree manual": "tree(manual)", "normal manual": "normal(manual)" },
  brim_type: { "auto": "auto_brim", "mouse ears": "brim_ears", "ears": "brim_ears", "brim ears": "brim_ears", "outer brim only": "outer_only", "outer": "outer_only", "outer only": "outer_only", "inner only": "inner_only", "inner brim only": "inner_only", "outer and inner": "outer_and_inner", "no brim": "no_brim", "none": "no_brim", "off": "no_brim" },
  ironing_type: { "none": "no ironing", "off": "no ironing", "no": "no ironing", "top surfaces": "top", "topmost surface": "topmost", "all solid": "solid" },
  sparse_infill_pattern: { "adaptive cubic": "adaptivecubic", "rectilinear": "line", "aligned rectilinear": "alignedrectilinear", "3d honeycomb": "3dhoneycomb", "hilbert curve": "hilbertcurve", "zig zag": "zig-zag", "support cubic": "supportcubic", "tri hexagon": "tri-hexagon" }
};

// One suggested value -> the string Orca stores, or { error }.
// raw: the model's machine value (`set`) when it gave one, else the display
// value ("0.12 mm", "Tree (auto)", "220 °C").
function normalize(key, raw) {
  const rule = TUNE[key];
  if (!rule) return { error: "not a setting this button may change" };
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { error: "no value" };
  if (/;|\n/.test(s)) return { error: "more than one value" };
  if (rule.kind === "bool") {
    if (ON.test(s)) return { value: "1" };
    if (OFF.test(s)) return { value: "0" };
    return { error: "not on or off" };
  }
  if (rule.kind === "enum") {
    const low = s.toLowerCase().replace(/[_\s]+/g, " ").replace(/\s*\(\s*/g, " ").replace(/\s*\)\s*/g, " ").trim();
    const exact = rule.vals.find(v => v.toLowerCase() === s.toLowerCase());
    if (exact) return { value: exact };
    const alias = (ENUM_ALIAS[key] || {})[low];
    if (alias) return { value: alias };
    const squash = x => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    const loose = rule.vals.find(v => squash(v) === squash(s));
    if (loose) return { value: loose };
    return { error: "not one of Orca's choices (" + rule.vals.slice(0, 6).join(", ") + (rule.vals.length > 6 ? ", …" : "") + ")" };
  }
  // numbers: one number, optionally followed by a unit; ranges are refused
  const m = /^(-?\d+(?:\.\d+)?)\s*(%|mm\/s|mm|°c|°|c|s|sec|seconds|layers?|loops?|walls?)?$/i.exec(s);
  if (!m) return { error: "not a single number" };
  const n = Number(m[1]);
  if (rule.kind === "pct") {
    if (m[2] && m[2] !== "%") return { error: "not a percentage" };
    if (n < rule.lo || n > rule.hi) return { error: "outside " + rule.lo + "-" + rule.hi + "%" };
    return { value: String(n) + "%" };
  }
  if (m[2] === "%") return { error: "a percentage where Orca wants a number" };
  if (rule.int && !Number.isInteger(n)) return { error: "must be a whole number" };
  if (n < rule.lo || n > rule.hi) return { error: "outside " + rule.lo + "-" + rule.hi };
  return { value: String(n) };
}

const asArr = v => Array.isArray(v) ? v.slice() : (v == null ? [] : String(v).split(";"));

// ps: parsed project_settings.config. settings: the suggester's rows
// [{ key, value, set? }]. Returns { ps (new object), applied, skipped }.
function applyTuning(ps, settings) {
  const out = JSON.parse(JSON.stringify(ps || {}));
  const applied = [], skipped = [];
  const types = asArr(out.filament_type).map(t => String(t || "").trim().toUpperCase()).filter(Boolean);
  const oneMaterial = types.length > 0 && types.every(t => t === types[0]);
  // How many filaments the project defines: Orca's own count is the length
  // of filament_settings_id; painted U1 projects carry far more than four
  // (Espeon: 24). different_settings_to_system is [process, one per
  // filament, printer], so its length follows that count - a fixed 4-slot
  // list would file the printer's entry under filament 5.
  const nFil = Math.max(asArr(out.filament_settings_id).length, types.length, 1);
  let diff = asArr(out.different_settings_to_system);
  if (!diff.length) diff = Array(nFil + 2).fill("");
  const filIdx = []; for (let i = 1; i < diff.length - 1; i++) filIdx.push(i);
  const addDiff = (i, k) => { const set = new Set(String(diff[i] || "").split(";").filter(Boolean)); set.add(k); diff[i] = [...set].sort().join(";"); };
  const seen = new Set();
  for (const row of Array.isArray(settings) ? settings : []) {
    const key = String((row && row.key) || "").trim();
    if (!key) continue;
    const shown = row.value != null ? String(row.value) : "";
    if (seen.has(key)) { skipped.push({ key, value: shown, reason: "suggested twice; the first one was used" }); continue; }
    seen.add(key);
    const raw = row.set != null && String(row.set).trim() !== "" ? row.set : row.value;
    const n = normalize(key, raw);
    if (n.error) { skipped.push({ key, value: shown, reason: n.error }); continue; }
    const rule = TUNE[key];
    // 2.47: a value the file already has is not a change - it used to be
    // written anyway and counted ("support angle 30 -> 30"), so the card
    // overstated what was tuned and Orca marked untouched settings as edited.
    const curVals = asArr(out[key]).map(v => String(v));
    if (curVals.length && curVals.every(v => v === n.value)) { skipped.push({ key, value: shown, reason: "already " + n.value + " in the file" }); continue; }
    if (rule.filament) {
      if (!oneMaterial) { skipped.push({ key, value: shown, reason: "the slots hold different materials; set it per filament in Orca" }); continue; }
      const cur = asArr(out[key]);
      // Same length the project already has: Orca reads these per filament,
      // and a list longer than its siblings is not something it writes itself.
      const slots = cur.length || nFil;
      const before = cur.length ? cur.join(";") : null;
      out[key] = Array(slots).fill(n.value);
      filIdx.forEach(i => addDiff(i, key));
      applied.push({ key, from: before, to: n.value });
    } else {
      const before = out[key] == null ? null : String(out[key]);
      out[key] = n.value;
      addDiff(0, key);
      applied.push({ key, from: before, to: n.value });
    }
  }
  if (applied.length) out.different_settings_to_system = diff;
  return { ps: out, applied, skipped };
}

// ---- 2.47: house rules ------------------------------------------------------
// Danny's shop defaults, enforced HERE so the AI decides only inside them.
// The prompt states them too (advisor.js MODEL_SYSTEM), but a prompt is a
// suggestion: on 2026-10-25 the 3DGOB Meerkat and the IXPatch Charizard both
// came back with supports turned on, though their designers print them
// without any (and painted none). The rules:
//   - infill is 12% gyroid, unless the AI calls the part structural and says
//     why; then its density stands (never under 12%), still as gyroid;
//   - on a flexi / articulated model, support settings stay
//     exactly as the designer set them - tree supports grow into the joint
//     gaps and fuse them;
//   - supports the designer painted are never switched off (and when the
//     paint could not be counted, supports are not switched off either);
//   - layers never below 0.16 mm (Danny prints 95% of his jobs at 0.16).
// 2.47.1: the numbers are settings now (models.house in config.json, from the
// Folder panel), because the Hub ships to other farms: HOUSE below is only the
// default. A blank infill turns the infill rule off (the AI's infill stands);
// a blank minimum layer turns the floor off. The flexi designer list starts
// EMPTY for everyone - each farm builds its own (models.flexiDesigners);
// a model named Flexi or Articulated is still a flexi.
const HOUSE = { infill: "12%", infillPct: 12, pattern: "gyroid", minLayer: 0.16 };
const FLEXI_DESIGNERS = [];
const PATTERNS = TUNE.sparse_infill_pattern.vals;

// config.json models -> { infillPct (null = off), infill, pattern, minLayer (null = off) }.
// Absent keys fall back to HOUSE; an explicit null or "" turns that rule off.
function houseConf(models) {
  const h = (models && typeof models === "object" && models.house && typeof models.house === "object") ? models.house : {};
  const numOrOff = (v, dflt, lo, hi) => {
    if (v === undefined) return dflt;
    if (v === null || String(v).trim() === "") return null;
    const n = Number(String(v).replace(/%$/, ""));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const infillPct = numOrOff(h.infill, HOUSE.infillPct, 0, 100);
  const pat = String(h.pattern == null ? "" : h.pattern).trim().toLowerCase();
  const pattern = PATTERNS.includes(pat) ? pat : HOUSE.pattern;
  const minLayer = numOrOff(h.minLayer, HOUSE.minLayer, 0.04, 0.32);
  return { infillPct, infill: infillPct == null ? null : infillPct + "%", pattern, minLayer };
}
// The flexi designer list from config.json models (one name per entry).
function flexiList(models) {
  const v = models && typeof models === "object" ? models.flexiDesigners : null;
  return Array.isArray(v) ? v.map(x => String(x || "").trim()).filter(Boolean) : FLEXI_DESIGNERS.slice();
}
// 2.47.1: "print-in-place" alone no longer makes a flexi (Danny, 2026-10-28):
// a print-in-place hinge or box is not a flexi, and it may need supports.
const FLEXI_RE = /\b(flexi|flexy|articulated|articulating)\b/i;
const SUPPORT_KEYS = new Set(["enable_support", "support_type", "support_threshold_angle", "support_on_build_plate_only"]);
const INFILL_KEYS = new Set(["sparse_infill_density", "sparse_infill_pattern"]);

// texts: title, file name, part names; designer: the designer folder;
// designers: the shop's list of designers whose models are flexis.
function isFlexi({ texts = [], designer = "", designers = FLEXI_DESIGNERS } = {}) {
  for (const t of texts) { const m = FLEXI_RE.exec(String(t || "")); if (m) return { flexi: true, why: "\"" + m[1] + "\" in \"" + String(t).slice(0, 60) + "\"" }; }
  const d = String(designer || "").trim().toLowerCase();
  if (d && (designers || []).some(x => String(x).trim().toLowerCase() === d)) return { flexi: true, why: designer + " is on the flexi designer list" };
  return { flexi: false, why: null };
}

// The designer folder from a library rel ("U1/IXPatch/Charizard/x.3mf" -> "IXPatch").
function designerFromRel(rel) {
  const parts = String(rel || "").split(/[\\/]+/).filter(Boolean);
  if (parts.length > 1 && /^(u1|prusa-format|bambu)$/i.test(parts[0])) parts.shift();
  return parts.length > 1 ? parts[0] : "";
}

const numOf = row => { const m = /-?\d+(?:\.\d+)?/.exec(String(row.set != null && String(row.set).trim() !== "" ? row.set : row.value)); return m ? Number(m[0]) : NaN; };
const valOf = row => String(row.set != null && String(row.set).trim() !== "" ? row.set : row.value);

// ps: the project's settings; settings: the AI's rows; h: { flexi: { flexi, why },
// supportPaint: faces (null = unknown), structural: { is, why } }.
// Returns { settings (what may be written), notes [{ key, value, reason }] }.
function houseRules(ps, settings, h) {
  h = h || {};
  const R = h.rules || HOUSE;                       // 2.47.1: the farm's own numbers
  const flexi = h.flexi && h.flexi.flexi;
  const structural = !!(h.structural && h.structural.is);
  const designerSupports = String((ps || {}).enable_support) === "1";
  const out = [], notes = [];
  const note = (row, reason) => notes.push({ key: row.key, value: row.value != null ? String(row.value) : "", reason: "house rule: " + reason });
  let density = null, pattern = null;
  for (const row of Array.isArray(settings) ? settings : []) {
    const key = String((row && row.key) || "").trim();
    if (SUPPORT_KEYS.has(key)) {
      if (flexi) { note(row, "flexi - supports stay as the designer set them (" + (h.flexi.why || "flexi") + ")"); continue; }
      if (key === "enable_support" && designerSupports && !ON.test(valOf(row).trim()) && (h.supportPaint == null || h.supportPaint > 0)) {
        note(row, h.supportPaint ? "the designer painted supports on " + h.supportPaint + " faces; they stay on" : "supports stay on - the painted supports could not be counted");
        continue;
      }
    }
    if (key === "layer_height" && R.minLayer != null && numOf(row) < R.minLayer) { note(row, "layers never below " + R.minLayer + " mm"); continue; }
    if (INFILL_KEYS.has(key) && R.infillPct != null) {
      if (!structural) { note(row, "infill is " + R.infill + " " + R.pattern + " unless the part is structural"); continue; }
      if (key === "sparse_infill_density") density = row; else pattern = row;
      continue;
    }
    out.push(row);
  }
  if (R.infillPct == null) return { settings: out, notes };   // infill rule off: the AI's infill stands
  // Infill last, so it reads as the house setting it is.
  let d = R.infill;
  if (structural && density) {
    const n = numOf(density);
    if (n >= R.infillPct) d = n + "%";
    else note(density, "structural infill is never under the house " + R.infill);
  }
  if (structural && pattern && valOf(pattern).toLowerCase() !== R.pattern) note(pattern, "infill pattern is " + R.pattern);
  out.push({ key: "sparse_infill_density", label: structural ? "Infill (structural)" : "Infill (house)", value: d, set: d, why: structural ? (h.structural.why || "structural part") : "house default" });
  out.push({ key: "sparse_infill_pattern", label: "Infill pattern (house)", value: R.pattern, set: R.pattern, why: "house default" });
  return { settings: out, notes };
}

// The whole 3MF: every entry kept byte for byte except the settings file.
// house (2.47): when given, the house rules run first and their notes lead
// the skipped list.
function tuneBuffer(buf, settings, house) {
  const entries = zipRead(buf);
  const e = entries.find(x => x.name === PS);
  if (!e) throw new Error("not a project 3MF (no project_settings.config)");
  let ps;
  try { ps = JSON.parse(zipEntryContent(e).toString("utf8")); }
  catch { throw new Error("project_settings.config is not valid JSON"); }
  const hr = house ? houseRules(ps, settings, house) : { settings, notes: [] };
  const r = applyTuning(ps, hr.settings);
  const out = entries.map(x => x.name === PS ? makeEntry(PS, Buffer.from(JSON.stringify(r.ps, null, 4), "utf8")) : x);
  return { buffer: zipWrite(out), applied: r.applied, skipped: hr.notes.concat(r.skipped), printer: String(ps.printer_model || "") };
}

module.exports = { TUNE, normalize, applyTuning, tuneBuffer, HOUSE, FLEXI_DESIGNERS, isFlexi, designerFromRel, houseRules, houseConf, flexiList };
