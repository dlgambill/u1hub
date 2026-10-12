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

// The whole 3MF: every entry kept byte for byte except the settings file.
function tuneBuffer(buf, settings) {
  const entries = zipRead(buf);
  const e = entries.find(x => x.name === PS);
  if (!e) throw new Error("not a project 3MF (no project_settings.config)");
  let ps;
  try { ps = JSON.parse(zipEntryContent(e).toString("utf8")); }
  catch { throw new Error("project_settings.config is not valid JSON"); }
  const r = applyTuning(ps, settings);
  const out = entries.map(x => x.name === PS ? makeEntry(PS, Buffer.from(JSON.stringify(r.ps, null, 4), "utf8")) : x);
  return { buffer: zipWrite(out), applied: r.applied, skipped: r.skipped, printer: String(ps.printer_model || "") };
}

module.exports = { TUNE, normalize, applyTuning, tuneBuffer };
