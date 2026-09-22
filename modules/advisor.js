// modules/advisor.js — AI pre-flight for a sliced file (v2.25).
//
// From a Reddit thread (r/SnapmakerU1, 2026-09-11): people were uploading
// their 3MF to ChatGPT before every print and asking it to sanity-check the
// slicer settings. The Hub sees the SLICED file, so it cannot change settings,
// but it holds everything a second pair of eyes would want: the settings Orca
// writes into the gcode (layer height, speeds, temperatures, fan, supports,
// prime tower, retraction), what filament the file was sliced for, what is on
// the plate, and — the part ChatGPT never has — what is actually loaded in the
// printer you are about to push to. This module writes that up as a compact
// brief, sends it to Claude with the person's own API key, and shows the
// answer on the job card. GO / CHECK / STOP, then the reasons, most important
// first.
//
// Rules this module keeps, in the order that shaped it:
//   1. Nothing is sent until a person presses the button. No background
//      reviews, no review-on-select, no retries. The Hub's promise that nothing
//      leaves the network is only broken on an explicit tap, by a key the
//      person pasted in themselves, and Settings says so in plain words.
//   2. Never the whole file. The brief is a few thousand characters: named
//      settings, filament list, plate summary, printer loadout. A 40 MB gcode
//      stays on the disk. This is also what keeps a review under a cent.
//   3. The key lives in config.json on the Hub computer, is never sent back to
//      the browser (the API answers key_set + last four), and is cleared by
//      saving an empty field.
//   4. Same file + same loadout = same answer, from the cache, free. "Ask
//      again" bypasses it.
//   5. Anthropic only, for now. The request is a plain fetch to the Messages
//      API — no SDK, nothing to install. Adding a second provider is one more
//      request shape, not a redesign.
//
// v2.28 adds the other half, one step earlier: POST /api/advisor/model takes a
// 3MF from the Models tab and asks for the slicer settings it should be sliced
// with. Danny: the 2.25 shape "doesn't exactly match what I wanted - I want it
// to evaluate a 3MF and suggest the best slicer settings for it." What makes
// that answerable rather than boilerplate is what goes in: the plate render
// the designer saved inside the file (sent as an image - the model can look at
// a picture), geometry measured from the meshes themselves (modules/mesh3mf.js:
// size, tallest part against its base, share of surface that overhangs,
// undersides that float, bed contact, painted faces, solid volume), the
// designer's own profile from project_settings.config, and what is loaded in
// the printer it would go to. The answer is JSON - a settings sheet the tab
// renders as a table - never free text pasted into the page. Same key, same
// model menu, same cache rules, same "nothing leaves until you press it".

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseGcodeMap, parseConfig } = require("../parser.js");
const { facts3mf, platesFromModelSettings } = require("./mesh3mf.js");

const API_DEFAULT = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const TIMEOUT_MS = 90000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;   // Orca's config block sits at the end; 256 KB covers it with room
const CACHE_MAX = 60;

// Model menu. Prices are USD per million tokens (input, output), for the cost
// line under each review; they are shown as an estimate and nothing here
// depends on them being exact.
const MODELS = Object.freeze({
  "claude-sonnet-5":   { label: "Claude Sonnet 5 (recommended)", in: 2, out: 10 },
  "claude-haiku-4-5":  { label: "Claude Haiku 4.5 (cheapest)",   in: 1, out: 5 },
  "claude-opus-5":     { label: "Claude Opus 5 (most thorough)", in: 5, out: 25 }
});
const MODEL_DEFAULT = "claude-sonnet-5";

// The settings worth a reviewer's attention. Everything Orca writes is several
// hundred keys; these are the ones that decide whether a print works.
const SETTING_KEYS = [
  "printer_model", "printer_settings_id", "print_settings_id", "filament_settings_id", "nozzle_diameter",
  "layer_height", "initial_layer_print_height", "initial_layer_height", "wall_loops", "top_shell_layers", "bottom_shell_layers",
  "sparse_infill_density", "sparse_infill_pattern", "infill_wall_overlap",
  "enable_support", "support_type", "support_style", "support_threshold_angle", "support_on_build_plate_only", "support_interface_top_layers", "support_filament",
  "enable_prime_tower", "prime_tower_width", "prime_volume", "wipe_tower_no_sparse_layers", "flush_multiplier",
  "brim_type", "brim_width", "skirt_loops", "curr_bed_type",
  "nozzle_temperature", "nozzle_temperature_initial_layer",
  "hot_plate_temp", "hot_plate_temp_initial_layer", "cool_plate_temp", "cool_plate_temp_initial_layer",
  "textured_plate_temp", "textured_plate_temp_initial_layer", "eng_plate_temp", "eng_plate_temp_initial_layer",
  "chamber_temperature", "activate_chamber_temp_control",
  "fan_min_speed", "fan_max_speed", "close_fan_the_first_x_layers", "overhang_fan_speed", "overhang_fan_threshold", "slow_down_for_layer_cooling", "slow_down_layer_time", "additional_cooling_fan_speed",
  "filament_max_volumetric_speed", "filament_flow_ratio", "filament_density", "filament_diameter", "filament_retraction_length", "filament_z_hop",
  "retraction_length", "retract_lift_above", "z_hop", "z_hop_types", "retraction_speed", "wipe",
  "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "internal_solid_infill_speed", "top_surface_speed", "initial_layer_speed", "initial_layer_infill_speed", "travel_speed", "bridge_speed", "overhang_1_4_speed", "overhang_4_4_speed",
  "default_acceleration", "outer_wall_acceleration", "initial_layer_acceleration",
  "enable_pressure_advance", "pressure_advance",
  "seam_position", "ironing_type", "detect_thin_wall", "only_one_wall_top", "spiral_mode", "print_sequence",
  "enable_overhang_speed", "enable_arc_fitting", "xy_hole_compensation", "xy_contour_compensation", "elefant_foot_compensation",
  "filament_soluble", "filament_is_support", "filament_vendor", "filament_type",
  "bed_exclude_area", "printable_height"
];

const SYSTEM = [
  "You are a pre-flight checker for a small farm of Snapmaker U1 3D printers (four tool heads on one carriage, one filament per head, automatic tool changes, a heated bed, a 270 x 270 x 270 mm volume).",
  "You will be given the slicer settings baked into a gcode file, the filament the file was sliced for, a summary of the plate, and what is actually loaded in the printer it is about to be sent to.",
  "Your job is to catch anything likely to produce a failed or poor print BEFORE it starts: wrong material or temperature for what is loaded, a head that is empty or holds the wrong filament for a color the file needs, missing supports for a tall or bridged part when the settings suggest one, bed temperature wrong for the plate type, cooling or speed settings that do not suit the material, a prime tower missing on a multi-color print, first-layer settings that risk adhesion, and so on.",
  "Be concrete and short. First line: exactly one of GO, CHECK, or STOP, followed by a colon and one sentence. Then at most six bullet points, most important first, each naming the setting or head and what to do about it. Do not restate settings that are fine. Do not pad. If nothing is wrong, say GO and one sentence, and stop.",
  "You cannot see the model's geometry; when something depends on it (overhangs, bridges, small parts), say so in a few words rather than guessing.",
  "Settings you are not given were not in the file; do not invent them."
].join("\n");

// ---- the 3MF settings suggester (v2.28) --------------------------------------
const MODEL_SYSTEM = [
  "You choose slicer settings for a 3MF that is about to be sliced in Snapmaker Orca (an OrcaSlicer fork) for a Snapmaker U1: four tool heads on one carriage, one filament per head, automatic tool changes, heated bed, 270 x 270 x 270 mm, 0.4 mm nozzle unless told otherwise.",
  "You are given: the plate render saved inside the file (an image, when there is one); geometry MEASURED from the meshes (sizes in mm, the tallest part against its narrowest base, what share of the surface faces down steeply enough to need support at Orca's 30 degree default, undersides that float, bed contact, painted faces, solid volume); the designer's own profile from the project (the settings the file already carries, often for a different printer); and what filament is loaded in the printer it would go to.",
  "Recommend the settings a careful operator would set before slicing this specific model for this specific machine and material. Anchor on the designer's profile: keep what is right, change only what the geometry, the material, or the U1 calls for, and say why in a few words. Use Orca's setting keys so a person can find them. Temperatures follow the LOADED material (and the roll's recommended temps when given), not the designer's file.",
  "Do not guess at geometry you were not given; the numbers are the truth, the image is for context (shape, detail, how parts sit). If the file already carries a support or brim choice that the numbers agree with, keep it and say so.",
  "Answer with ONE JSON object and nothing else, no code fence, this shape:",
  '{"summary":"one sentence on what this model needs","settings":[{"key":"layer_height","label":"Layer height","value":"0.12 mm","from":"0.2 mm","why":"small painted details"}],"heads":[{"color":"#FF0000","head":"T2","note":"red PLA loaded there"}],"watch":["short warnings, most important first"],"orientation":"one sentence, or null if the plate is fine as is"}',
  "settings: at most 14 entries, most consequential first; \"from\" is the designer's value when yours differs, else null; \"why\" under 20 words. heads: only when the project's filament colors and the loaded rolls let you map them (else an empty array). watch: at most 5. Keep values in the units Orca shows."
].join("\n");

// Keys worth carrying from the project's own settings, and their answer.
const PROJECT_KEYS = [
  "printer_model", "printer_settings_id", "print_settings_id", "nozzle_diameter",
  "layer_height", "initial_layer_print_height", "wall_loops", "top_shell_layers", "bottom_shell_layers",
  "sparse_infill_density", "sparse_infill_pattern",
  "enable_support", "support_type", "support_style", "support_threshold_angle", "support_on_build_plate_only", "support_interface_top_layers",
  "enable_prime_tower", "prime_tower_width", "flush_multiplier",
  "brim_type", "brim_width", "skirt_loops", "curr_bed_type",
  "nozzle_temperature", "nozzle_temperature_initial_layer", "hot_plate_temp", "textured_plate_temp", "cool_plate_temp",
  "fan_min_speed", "fan_max_speed", "slow_down_layer_time", "overhang_fan_speed",
  "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed", "initial_layer_speed",
  "seam_position", "ironing_type", "detect_thin_wall", "only_one_wall_top", "xy_hole_compensation", "elefant_foot_compensation",
  "filament_type", "filament_settings_id", "filament_vendor"
];

// project_settings.config (JSON) -> the whitelisted lines. Values are strings
// or per-filament arrays; arrays are joined so "220;220;220;220" reads as one.
function projectLines(ps) {
  const lines = [];
  let j = null;
  try { j = JSON.parse(ps.toString("utf8")); } catch { return lines; }
  for (const k of PROJECT_KEYS) {
    if (!(k in j)) continue;
    let v = Array.isArray(j[k]) ? j[k].map(x => String(x)).join(";") : String(j[k]);
    if (v.length > 120) v = v.slice(0, 117) + "…";
    lines.push("  " + k + " = " + v);
  }
  return lines;
}

// Pure: everything about the file -> the text half of the brief.
// facts: mesh3mf facts (or { ok:false, reason }); info: colors/objects from
// models.js infoFromParts; project: projectLines(); plate: { n, of }.
function modelBriefLines(name, facts, info, project, plate) {
  const L = [];
  L.push("FILE: " + name);
  const md = (facts && facts.metadata) || {};
  const tit = [md.Title ? "title \"" + md.Title + "\"" : null, md.Designer ? "by " + md.Designer : null, md.ProfileTitle ? "designer's profile \"" + md.ProfileTitle + "\"" : null, md.Application ? "saved by " + md.Application : null].filter(Boolean);
  if (tit.length) L.push("PROJECT: " + tit.join(", "));
  if (plate && plate.of > 1) L.push("PLATE: " + plate.n + " of " + plate.of + " in this project (only this plate is measured below)");
  if (facts && facts.ok) {
    const f = facts;
    L.push("GEOMETRY (measured from the meshes, mm): plate footprint " + f.size_mm[0] + " x " + f.size_mm[1] + ", tallest point " + f.height_mm + "; "
      + f.instances + " part" + (f.instances === 1 ? "" : "s") + " on the plate (" + f.meshes + " distinct mesh" + (f.meshes === 1 ? "" : "es") + "), " + f.triangles.toLocaleString("en-US") + " triangles; solid volume " + f.volume_cm3 + " cm3 (" + f.solid_g_pla + " g if printed solid in PLA); surface " + f.area_cm2 + " cm2" + (f.truncated ? "; NOTE: mesh data past the size budget, numbers are partial" : ""));
    const o = f.overhang;
    L.push("OVERHANGS: " + o.steep_pct + "% of the surface faces down steeper than 30 degrees from vertical (needs support at Orca's default threshold); " + o.flat_unsupported_pct + "% is flat underside not on the bed (bridges or floating)" + (o.floating_instances ? "; " + o.floating_instances + " part" + (o.floating_instances === 1 ? " sits" : "s sit") + " above the plate with nothing under it" : "") + "; bed contact " + o.bed_contact_cm2 + " cm2 = " + o.bed_contact_pct_of_footprint + "% of the footprint");
    if (f.tallest) L.push("STABILITY: tallest part is " + f.tallest.height_mm + " mm on a " + f.tallest.base_mm[0] + " x " + f.tallest.base_mm[1] + " mm base (height " + f.tallest.aspect + "x its narrowest base dimension)");
    if (f.paint && f.paint.colors) L.push("PAINT: faces are painted with " + f.paint.colors + " color" + (f.paint.colors === 1 ? "" : "s") + " (" + f.paint.painted_pct + "% of faces) - multi-color by painting, not by separate objects");
    if (f.parts && f.parts.length) L.push("PARTS (largest first): " + f.parts.map(p => (p.name || "part") + (p.copies > 1 ? " x" + p.copies : "") + " " + p.size_mm.join("x") + " mm " + p.volume_cm3 + " cm3").join("; "));
  } else L.push("GEOMETRY: not measured (" + ((facts && facts.reason) || "no mesh") + ")");
  if (info) {
    if (info.colors && info.colors.length) L.push("FILAMENTS DEFINED IN THE PROJECT (slot: color): " + info.colors.map((c, i) => (i + 1) + ": " + c).join(", "));
    if (info.objects && info.objects.length) L.push("OBJECTS (name, extruder slot): " + info.objects.slice(0, 16).map(x => x.name + (x.extruder ? " (" + x.extruder + ")" : "")).join("; ") + (info.objects.length > 16 ? "; …" : ""));
  }
  L.push("DESIGNER'S PROJECT SETTINGS (from the 3MF; the target printer may differ):");
  if (project && project.length) L.push(...project); else L.push("  (no project_settings.config in this file)");
  return L;
}

// The model's JSON, tolerant of a stray sentence or fence around it.
function parseSuggestion(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j = null;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const str = v => v == null ? null : String(v);
  const out = {
    summary: str(j.summary) || "",
    settings: (Array.isArray(j.settings) ? j.settings : []).slice(0, 14).map(x => ({ key: str(x.key) || "", label: str(x.label) || str(x.key) || "", value: str(x.value) || "", from: str(x.from), why: str(x.why) || "" })).filter(x => x.key || x.label),
    heads: (Array.isArray(j.heads) ? j.heads : []).slice(0, 8).map(x => ({ color: str(x.color) || "", head: str(x.head) || "", note: str(x.note) || "" })),
    watch: (Array.isArray(j.watch) ? j.watch : []).slice(0, 5).map(str).filter(Boolean),
    orientation: str(j.orientation)
  };
  return out.settings.length || out.summary ? out : null;
}

// The plate image for the model: the mid-size render first (512 px is plenty
// and a few hundred tokens), the small one if that is all there is. Never a
// photo from Auxiliaries/ - those are the designer's listing pictures.
function pickVisionThumb(entries) {
  const order = [/^Metadata\/plate_1\.png$/i, /^Metadata\/plate_\d+\.png$/i, /^Metadata\/plate_1_small\.png$/i, /^Metadata\/plate_\d+_small\.png$/i, /^Metadata\/thumbnail.*\.png$/i, /^Thumbnails\/.*\.png$/i];
  for (const re of order) { const e = entries.find(x => re.test(x.name) && (x.usize || 0) <= 900 * 1024); if (e) return e; }
  return null;
}

// ---- file brief -------------------------------------------------------------
// v2.28: async. The sync version stalled the loop for the length of two reads
// on the share (MISTAKES.md 2026-09-14 rule: nothing synchronous touches the
// share from a request handler).
async function readEnds(fp) {
  const st = await fs.promises.stat(fp);
  if (st.size <= HEAD_BYTES + TAIL_BYTES) return { text: await fs.promises.readFile(fp, "utf8"), size: st.size, mtime: st.mtimeMs };
  const fh = await fs.promises.open(fp, "r");
  try {
    const h = Buffer.alloc(HEAD_BYTES); await fh.read(h, 0, HEAD_BYTES, 0);
    const t = Buffer.alloc(TAIL_BYTES); await fh.read(t, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    return { text: h.toString("utf8") + "\n" + t.toString("utf8"), size: st.size, mtime: st.mtimeMs };
  } finally { await fh.close(); }
}

// Pure: text -> { lines[], meta }. Exported for the harness.
function briefFromText(text, name) {
  const { cfg } = parseConfig(text);
  const map = parseGcodeMap(text, { scanBody: false });
  const colon = k => { const m = new RegExp("^;\\s*" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*[:=]\\s*(.+)$", "mi").exec(text); return m ? m[1].trim() : null; };
  const objects = new Set();
  for (const m of text.matchAll(/EXCLUDE_OBJECT_DEFINE\s+NAME=([^\s]+)/g)) objects.add(m[1]);
  const lines = [];
  lines.push("FILE: " + name);
  const facts = [];
  if (map.estTime) facts.push("estimated time " + map.estTime);
  const tot = map.amounts && map.amounts.total_g != null ? map.amounts.total_g : (map.amounts ? map.amounts.slot_sum_g : null);
  if (tot != null) facts.push("filament " + Math.round(tot) + " g total");
  const layers = colon("total layer number") || cfg["total layer number"];
  if (layers) facts.push(layers + " layers");
  const zmax = colon("max_z_height");
  if (zmax) facts.push("height " + zmax + " mm");
  if (objects.size) facts.push(objects.size + " object" + (objects.size === 1 ? "" : "s") + " on the plate");
  if (map.amounts && map.amounts.tool_changes != null) facts.push(map.amounts.tool_changes + " tool changes");
  if (facts.length) lines.push("PLATE: " + facts.join(", "));
  if (objects.size) lines.push("OBJECTS: " + [...objects].slice(0, 12).join(", ") + (objects.size > 12 ? ", …" : ""));
  lines.push("FILAMENTS THE FILE WAS SLICED FOR (logical slot: type, vendor, color, grams):");
  for (const p of map.palette || []) {
    if (!p.present && !p.used) continue;
    lines.push("  T" + (p.i + 1) + ": " + (p.type || "?") + (p.vendor ? " " + p.vendor : "") + (p.hex ? " " + p.hex : "") + (p.grams != null ? " " + (Math.round(p.grams * 10) / 10) + " g" : "") + (p.used ? "" : " (not used)"));
  }
  lines.push("SLICER SETTINGS:");
  let n = 0;
  for (const k of SETTING_KEYS) {
    if (!(k in cfg)) continue;
    let v = String(cfg[k]);
    if (v.length > 120) v = v.slice(0, 117) + "…";
    lines.push("  " + k + " = " + v);
    n++;
  }
  if (!n) lines.push("  (no Orca config block found in this file)");
  return { lines, meta: { settings: n, estTime: map.estTime, total_g: tot, palette: (map.palette || []).length, objects: objects.size } };
}

function printerBrief(p, idx, loadout, fleetEntry, mapping) {
  const lines = [];
  lines.push("TARGET PRINTER: " + p.name + " (" + (p.type || "u1") + ")" + (fleetEntry ? ", currently " + (fleetEntry.online ? (fleetEntry.state || "unknown") : "offline") : ""));
  if (fleetEntry && fleetEntry.bed) lines.push("  bed now " + Math.round(fleetEntry.bed.temp) + " C");
  lines.push("LOADED IN ITS HEADS (physical head: what the Hub has recorded; temps are the roll's recommended nozzle/bed):");
  const heads = (fleetEntry && Array.isArray(fleetEntry.heads) && fleetEntry.heads.length) ? fleetEntry.heads.length : 4;
  for (let h = 0; h < heads; h++) {
    const lo = (loadout || []).find(l => l.slot === h);
    const fh = fleetEntry && fleetEntry.heads ? fleetEntry.heads[h] : null;
    let s = "  T" + (h + 1) + ": ";
    if (lo && lo.spool_id) {
      s += [lo.brand, lo.material_variant || lo.material, lo.color_name || (lo.hex ? "#" + lo.hex : "")].filter(Boolean).join(" ");
      if (lo.hot_end_temp || lo.bed_temp) s += " (" + [lo.hot_end_temp ? lo.hot_end_temp + " C nozzle" : null, lo.bed_temp ? lo.bed_temp + " C bed" : null].filter(Boolean).join(", ") + ")";
    } else if (fh && fh.loaded && (fh.material || fh.hex)) {
      s += "printer reports " + [fh.vendor, fh.material, fh.sub, fh.hex].filter(Boolean).join(" ") + " (no roll recorded in the Hub, so no temps known)";
    } else s += "empty / nothing recorded";
    lines.push(s);
  }
  if (mapping && Object.keys(mapping).length) {
    lines.push("COLOR MAPPING THE USER CHOSE (file slot -> physical head): " + Object.entries(mapping).map(([l, h]) => "T" + (Number(l) + 1) + " -> T" + (Number(h) + 1)).join(", "));
  } else lines.push("COLOR MAPPING: not chosen yet; the printer will match by color at start.");
  return lines;
}

function parseVerdict(text) {
  const m = /^\s*\**\s*(GO|CHECK|STOP)\b/i.exec(String(text || ""));
  return m ? m[1].toUpperCase() : null;
}

function estimateCost(model, usage) {
  const p = MODELS[model];
  if (!p || !usage) return null;
  const c = ((usage.input_tokens || 0) * p.in + (usage.output_tokens || 0) * p.out) / 1e6;
  return Math.round(c * 10000) / 10000;
}

function register(ctx) {
  const FILE = path.join(ctx.baseDir, "advisor.json");
  let CACHE = [], MCACHE = [];   // gcode reviews; 3MF settings suggestions (v2.28)
  try { const j = JSON.parse(fs.readFileSync(FILE, "utf8")); CACHE = j.reviews || []; MCACHE = j.models || []; } catch {}
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ reviews: CACHE, models: MCACHE }, null, 2)); } catch {} };

  const conf = () => {
    const c = (ctx.cfg && typeof ctx.cfg.advisor === "object" && ctx.cfg.advisor) || {};
    return {
      key: typeof c.key === "string" ? c.key : "",
      model: (c.model && typeof c.model === "string") ? c.model : MODEL_DEFAULT,
      url: (typeof c.url === "string" && /^https?:\/\//.test(c.url)) ? c.url.replace(/\/+$/, "") : API_DEFAULT
    };
  };
  const keyOk = k => /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(String(k || ""));

  function view() {
    const c = conf();
    return {
      key_set: !!c.key, key_tail: c.key ? c.key.slice(-4) : null,
      model: c.model, models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, in: m.in, out: m.out })),
      reviews: CACHE.length,
      suggestions: MCACHE.length,
      last: CACHE.length ? { at: CACHE[CACHE.length - 1].at, file: CACHE[CACHE.length - 1].file, verdict: CACHE[CACHE.length - 1].verdict } : null,
      spent_usd: Math.round((CACHE.reduce((a, r) => a + (r.cost || 0), 0) + MCACHE.reduce((a, r) => a + (r.cost || 0), 0)) * 100) / 100
    };
  }

  // content: a string, or Messages-API content blocks (text + image).
  async function ask(c, content, maxTokens, system) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(c.url + "/v1/messages", {
        method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": API_VERSION },
        body: JSON.stringify({ model: c.model, max_tokens: maxTokens || 700, system: system || SYSTEM, messages: [{ role: "user", content }] })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = (body && body.error && body.error.message) || ("HTTP " + r.status);
        if (r.status === 401) throw new Error("Anthropic rejected the key (401). Check it in Settings.");
        if (r.status === 429) throw new Error("Rate limited by Anthropic (429). Wait a moment and try again.");
        if (r.status === 400 && /model/i.test(msg)) throw new Error("Anthropic did not accept the model \"" + c.model + "\": " + msg);
        throw new Error("Anthropic answered " + r.status + ": " + msg);
      }
      const text = Array.isArray(body.content) ? body.content.filter(x => x.type === "text").map(x => x.text).join("\n").trim() : "";
      if (!text) throw new Error("Anthropic answered with no text (stop_reason " + (body.stop_reason || "?") + ", content " + JSON.stringify(body.content || null).slice(0, 200) + ")");
      return { text, usage: body.usage || null, model: body.model || c.model };
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Anthropic did not answer within " + (TIMEOUT_MS / 1000) + " s");
      throw e;
    } finally { clearTimeout(t); }
  }

  ctx.app.get("/api/advisor", (req, res) => res.json(view()));

  ctx.app.post("/api/advisor/settings", (req, res) => {
    const b = req.body || {};
    const cur = (ctx.cfg.advisor && typeof ctx.cfg.advisor === "object") ? ctx.cfg.advisor : {};
    const next = { ...cur };
    if ("key" in b) {
      const k = String(b.key || "").trim();
      if (k && !keyOk(k)) return res.status(400).json({ error: "That does not look like an Anthropic API key (they start with sk-ant-)" });
      if (k) next.key = k; else delete next.key;
    }
    if ("model" in b) {
      const m = String(b.model || "").trim();
      if (m && !/^[a-z0-9.-]{3,60}$/i.test(m)) return res.status(400).json({ error: "model must be a plain model id like claude-sonnet-5" });
      if (m) next.model = m; else delete next.model;
    }
    if ("url" in b) {   // not in the UI; for tests and for a proxy someone runs themselves
      const u = String(b.url || "").trim();
      if (u && !/^https?:\/\//.test(u)) return res.status(400).json({ error: "url must be http(s)" });
      if (u) next.url = u.replace(/\/+$/, ""); else delete next.url;
    }
    ctx.cfg.advisor = next;
    ctx.saveConfig();
    res.json(view());
  });

  // Cheapest possible call, to prove the key works before anyone relies on it.
  ctx.app.post("/api/advisor/test", async (req, res) => {
    const c = conf();
    if (req.body && req.body.key) { if (!keyOk(req.body.key)) return res.status(400).json({ error: "That does not look like an Anthropic API key (they start with sk-ant-)" }); c.key = String(req.body.key); }
    if (req.body && req.body.model) c.model = String(req.body.model);
    if (!c.key) return res.status(409).json({ error: "No API key set" });
    try {
      const r = await ask(c, "Reply with the single word OK.", 5);
      res.json({ ok: true, model: r.model, reply: r.text.slice(0, 40) });
    } catch (e) { res.status(502).json({ ok: false, error: String((e && e.message) || e) }); }
  });

  // POST /api/advisor/review { file, type, printer, mapping?, force? }
  let BUSY = false;
  ctx.app.post("/api/advisor/review", async (req, res) => {
    const c = conf();
    if (!c.key) return res.status(409).json({ error: "Add an Anthropic API key in Settings first (Settings → AI pre-flight)." });
    const b = req.body || {};
    const name = path.basename(String(b.file || ""));
    if (!name) return res.status(400).json({ error: "Body needs { file }" });
    const slug = String(b.type || "u1");
    const fp = path.join(ctx.gcodeFolderFor(slug), name);
    const idx = Number(b.printer);
    const p = Number.isInteger(idx) ? (ctx.printers || [])[idx] : null;
    if (!p) return res.status(400).json({ error: "Pick the printer you are about to send this to" });
    if (BUSY) return res.status(409).json({ error: "A review is already running" });
    BUSY = true;
    try {
      let ends;
      try { ends = await readEnds(fp); }
      catch (e) { if (e && e.code === "ENOENT") return res.status(404).json({ error: "That file is not in the Hub library: " + name }); throw e; }
      const fb = briefFromText(ends.text, name);
      let fe = null;
      try { fe = ((await ctx.fleet()) || []).find(x => x.id === idx) || null; } catch {}
      const loadout = ctx.loadout ? (ctx.loadout(idx) || []) : [];
      const mapping = (b.mapping && typeof b.mapping === "object") ? b.mapping : null;
      const pb = printerBrief(p, idx, loadout, fe, mapping);
      const userText = fb.lines.concat([""], pb).join("\n");
      // Cache key: the settings brief + what is loaded (+ mapping). The
      // printer's live state (bed temp, idle/printing) is left out on purpose
      // so a review does not go stale because the bed cooled ten degrees.
      const keyText = fb.lines.join("\n") + "\n" + pb.filter(l => !/^  bed now|^TARGET PRINTER/.test(l)).join("\n") + "\n" + c.model;
      const ckey = crypto.createHash("sha1").update(keyText).digest("hex");
      const hit = !b.force && CACHE.find(r => r.key === ckey);
      if (hit) return res.json({ ...hit, cached: true, brief_chars: userText.length });
      const r = await ask(c, userText, 4000);   // v2.28: room for the model to think first (see /model below)
      const rec = { key: ckey, at: Date.now(), file: name, type: slug, printer: p.name, printer_id: idx, model: r.model,
                    verdict: parseVerdict(r.text), text: r.text, usage: r.usage, cost: estimateCost(c.model, r.usage), brief: fb.meta };
      CACHE = CACHE.filter(x => x.key !== ckey); CACHE.push(rec);
      if (CACHE.length > CACHE_MAX) CACHE.splice(0, CACHE.length - CACHE_MAX);
      save();
      ctx.hublog("info", "advisor: " + p.name + " / " + name + " -> " + (rec.verdict || "?") + (rec.cost != null ? " ($" + rec.cost.toFixed(4) + ")" : ""));
      res.json({ ...rec, cached: false, brief_chars: userText.length });
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
    } finally { BUSY = false; }
  });

  // What WOULD be sent, without sending it. Settings links here so a person
  // can read the brief for any file before trusting the feature with a key.
  ctx.app.get("/api/advisor/brief", async (req, res) => {
    const name = path.basename(String(req.query.file || ""));
    const slug = String(req.query.type || "u1");
    const fp = path.join(ctx.gcodeFolderFor(slug), name);
    if (!name) return res.status(404).json({ error: "file not in the library" });
    try {
      const fb = briefFromText((await readEnds(fp)).text, name);
      const idx = Number(req.query.printer);
      const p = Number.isInteger(idx) ? (ctx.printers || [])[idx] : null;
      const pb = p ? printerBrief(p, idx, ctx.loadout ? ctx.loadout(idx) : [], null, null) : [];
      res.type("text/plain").send(fb.lines.concat([""], pb).join("\n"));
    } catch (e) {
      if (e && e.code === "ENOENT") return res.status(404).json({ error: "file not in the library" });
      res.status(500).json({ error: e.message });
    }
  });

  // ---- 3MF settings suggester (v2.28) ------------------------------------------
  // Facts are measured once per file version and kept in memory: a rescan or
  // "Ask again" must not re-parse 16 MB of XML.
  const FACTS = new Map();   // "<path>:<mtime>" -> { facts, info, project, plate, thumb: { data, media_type } | null }
  async function gather(rel) {
    const open = ctx.use("models.open");
    if (!open) throw Object.assign(new Error("The Models module is off; turn it on to suggest settings for a 3MF"), { status: 503 });
    return open(rel, async (z, meta) => {
      const key = meta.path + ":" + meta.mtime;
      if (FACTS.has(key)) return FACTS.get(key);
      const ent = n => z.entries.find(e => e.name === n);
      const ps = ent("Metadata/project_settings.config"), ms = ent("Metadata/model_settings.config");
      const psBuf = ps ? await z.content(ps) : null, msBuf = ms ? await z.content(ms) : null;
      const info = ctx.use("models.info") ? ctx.use("models.info")(psBuf, msBuf) : null;
      const pl = platesFromModelSettings(msBuf ? msBuf.toString("utf8") : "");
      const only = pl.plates.length > 1 && pl.plates[0].objects.length ? new Set(pl.plates[0].objects) : null;
      let facts;
      try { facts = await facts3mf(z, { only, names: pl.names }); }
      catch (e) { facts = { ok: false, reason: e.message }; }
      const te = pickVisionThumb(z.entries);
      let thumb = null;
      if (te) { try { thumb = { data: (await z.content(te)).toString("base64"), media_type: "image/png", name: te.name }; } catch {} }
      const rec = { facts, info, project: psBuf ? projectLines(psBuf) : [], plate: { n: pl.plates.length ? pl.plates[0].id : 1, of: pl.plates.length || 1 }, thumb, path: meta.path, mtime: meta.mtime };
      FACTS.set(key, rec); if (FACTS.size > 120) FACTS.delete(FACTS.keys().next().value);
      return rec;
    });
  }
  function modelLoadoutLines(idx) {
    const p = Number.isInteger(idx) ? (ctx.printers || [])[idx] : null;
    if (!p) return ["TARGET PRINTER: not chosen; assume a Snapmaker U1 with PLA loaded and say which settings depend on the material."];
    return printerBrief(p, idx, ctx.loadout ? (ctx.loadout(idx) || []) : [], null, null).filter(l => !/^COLOR MAPPING/.test(l));
  }

  let MBUSY = false;
  // POST /api/advisor/model { file (rel in the models folder), printer?, force? }
  ctx.app.post("/api/advisor/model", async (req, res) => {
    const c = conf();
    if (!c.key) return res.status(409).json({ error: "Add an Anthropic API key in Settings first (Settings → AI pre-flight)." });
    const b = req.body || {};
    const rel = String(b.file || "");
    if (!rel) return res.status(400).json({ error: "Body needs { file }" });
    const idx = b.printer == null || b.printer === "" ? null : Number(b.printer);
    if (MBUSY) return res.status(409).json({ error: "A suggestion is already running" });
    MBUSY = true;
    try {
      let g;
      try { g = await gather(rel); }
      catch (e) { return res.status(e.status || (e && e.code === "ENOENT" ? 404 : 422)).json({ error: e.status ? e.message : "Could not read that 3MF: " + e.message }); }
      const name = rel.split("/").pop();
      const lines = modelBriefLines(name, g.facts, g.info, g.project, g.plate);
      const pb = modelLoadoutLines(idx);
      const text = lines.concat([""], pb, ["", "Return the JSON object now."]).join("\n");
      const keyText = lines.join("\n") + "\n" + pb.filter(l => !/^  bed now|^TARGET PRINTER/.test(l)).join("\n") + "\n" + c.model + (g.thumb ? "\n" + g.thumb.name : "");
      const ckey = crypto.createHash("sha1").update(keyText).digest("hex");
      const hit = !b.force && MCACHE.find(r => r.key === ckey);
      if (hit) return res.json({ ...hit, cached: true, facts: g.facts, thumb: !!g.thumb });
      const content = [];
      if (g.thumb) content.push({ type: "image", source: { type: "base64", media_type: g.thumb.media_type, data: g.thumb.data } });
      content.push({ type: "text", text: (g.thumb ? "Above: the plate render saved in the file.\n" : "(The file carries no plate render; go by the numbers.)\n") + text });
      // 8000, not the ~700 the answer needs: Sonnet 5 thinks before it answers
      // when the brief is long, and thinking tokens count against max_tokens.
      // At 1600 the first live call came back as one empty thinking block and
      // stop_reason max_tokens (2026-09-22, the donut keyring).
      const r = await ask(c, content, 8000, MODEL_SYSTEM);
      const sug = parseSuggestion(r.text);
      if (!sug) return res.status(502).json({ error: "The model did not answer with a settings sheet; try again", raw: r.text.slice(0, 400) });
      const p = Number.isInteger(idx) ? (ctx.printers || [])[idx] : null;
      const rec = { key: ckey, at: Date.now(), file: rel, printer: p ? p.name : null, printer_id: p ? idx : null, model: r.model,
                    suggestion: sug, usage: r.usage, cost: estimateCost(c.model, r.usage) };
      MCACHE = MCACHE.filter(x => x.key !== ckey); MCACHE.push(rec);
      if (MCACHE.length > CACHE_MAX) MCACHE.splice(0, MCACHE.length - CACHE_MAX);
      save();
      ctx.hublog("info", "advisor: settings for " + rel + (p ? " on " + p.name : "") + (rec.cost != null ? " ($" + rec.cost.toFixed(4) + ")" : ""));
      res.json({ ...rec, cached: false, facts: g.facts, thumb: !!g.thumb });
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
    } finally { MBUSY = false; }
  });

  // What would be sent for a 3MF (text half; the image is noted, not dumped).
  ctx.app.get("/api/advisor/model/brief", async (req, res) => {
    const rel = String(req.query.file || "");
    if (!rel) return res.status(404).json({ error: "file not in the models folder" });
    try {
      const g = await gather(rel);
      const idx = req.query.printer == null || req.query.printer === "" ? null : Number(req.query.printer);
      const lines = modelBriefLines(rel.split("/").pop(), g.facts, g.info, g.project, g.plate);
      res.type("text/plain").send((g.thumb ? "[image: " + g.thumb.name + " is sent alongside this text]\n\n" : "[no plate render in the file]\n\n") + lines.concat([""], modelLoadoutLines(idx)).join("\n"));
    } catch (e) { res.status(e.status || (e && e.code === "ENOENT" ? 404 : 422)).json({ error: e.message }); }
  });

  ctx.provide("advisor.state", () => view());
}

module.exports = { register, briefFromText, printerBrief, parseVerdict, estimateCost, MODELS, MODEL_DEFAULT, SETTING_KEYS, SYSTEM,
                   modelBriefLines, projectLines, parseSuggestion, pickVisionThumb, MODEL_SYSTEM, PROJECT_KEYS };
