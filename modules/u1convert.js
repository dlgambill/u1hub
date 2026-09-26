// modules/u1convert.js - Convert to U1 (v2.38, issue #5).
//
// A MakerWorld or Printables project is saved for the designer's printer
// (almost always a Bambu). Opened as-is in Snapmaker Orca it asks which
// printer, and the answer throws the designer's process away: the prime
// tower, walls, shells, infill and supports all go back to U1 defaults. The
// older transplant (u1ify in slicing.js, still what the Slice tab uses for
// the CLI) does the same on purpose - it swaps in a clean template's whole
// settings file, because the 2.4.2 CLI crashes on Bambu leftovers.
//
// This is the other half: keep what the designer decided, change what the
// printer decides.
//   - Printer and filament side: from the U1 template (a project Danny saved
//     in Snapmaker Orca for the U1). Those are the presets Orca must find.
//   - Process side: from the source, but only keys Snapmaker Orca's own
//     process profiles define (read from the install, a built-in list when
//     there is no install), only keys the template also has, and never the
//     tuning for the source printer (speeds, accelerations, temperatures,
//     flow, retraction, cooling, gcode hooks) - the U1 profile's values stay.
//     What crosses over is geometry: layers, walls, shells, infill, supports,
//     brim, prime tower, seam, bridges, ironing, fuzzy skin.
//   - Never carried: post_process (a downloaded file must not bring a
//     script that runs on export), filename_format, anything that names the
//     source machine, plate or filament presets.
//   - Filament slots: the designer's colors (so a painted model still looks
//     like itself); the template's filament presets and types (so temps are
//     right for the U1). A slot whose type differs is reported, not guessed.
//   - print_settings_id is resolved against the installed process presets.
//     A name Orca does not have makes it load the printer default and drop
//     every project process value with it (the spike's first pass, and every
//     MakerWorld file: "0.20mm Standard @BBL X1C").
//   - Stale embedded machine/process/filament members stripped, printer id
//     in slice_info patched, object extruders above 4 set to 1 - the same
//     three repairs u1ify makes.
// Verified by hand in Snapmaker Orca 2026-09-26 on two MakerWorld files
// (prime tower width 35, brim 3, walls 3, top shells 7, colors kept, no
// "printer not found").
//
// Pure: bytes in, bytes and a report out. The route (models.js) does the IO.
"use strict";

const path = require("path");
const fs = require("fs");
const { zipRead, zipWrite, zipEntryContent, padFilamentArrays, makeEntry } = require("./slicing.js");

const PS = "Metadata/project_settings.config";
const MS = "Metadata/model_settings.config";
const SI = "Metadata/slice_info.config";
const STALE_RE = /^Metadata\/(machine_settings_|process_settings_|filament_settings_).*\.config$/;
const U1 = "Snapmaker U1";
const SLOTS = 4;

// Process keys of Snapmaker Orca 2.x (union over resources/profiles/
// Snapmaker/process/*.json, Danny's install, 2026-09-26). Used when the
// install cannot be read - a Hub in Docker, or Orca somewhere else.
const BUILTIN_KEYS = [
  "adaptive_layer_height bottom_shell_layers bottom_shell_thickness bottom_solid_infill_flow_ratio",
  "bottom_surface_pattern bridge_acceleration bridge_angle bridge_density bridge_flow bridge_no_support",
  "bridge_speed brim_object_gap brim_type brim_width default_acceleration default_jerk description",
  "detect_narrow_internal_solid_infill detect_overhang_wall detect_thin_wall draft_shield",
  "elefant_foot_compensation enable_arc_fitting enable_overhang_speed enable_prime_tower enable_support",
  "enforce_support_layers ensure_vertical_shell_thickness exclude_object filename_format",
  "filter_out_gap_fill flush_into_infill flush_into_objects flush_into_support fuzzy_skin",
  "fuzzy_skin_point_distance fuzzy_skin_thickness gap_fill_enabled gap_fill_target gap_infill_speed",
  "gcode_add_line_number gcode_comments gcode_label_objects independent_support_layer_height",
  "infill_combination infill_direction infill_jerk infill_wall_overlap initial_layer_acceleration",
  "initial_layer_infill_speed initial_layer_jerk initial_layer_line_width initial_layer_print_height",
  "initial_layer_speed initial_layer_travel_speed inner_wall_acceleration inner_wall_jerk",
  "inner_wall_line_width inner_wall_speed interface_shells internal_bridge_speed",
  "internal_bridge_support_thickness internal_solid_infill_acceleration",
  "internal_solid_infill_line_width internal_solid_infill_pattern internal_solid_infill_speed",
  "ironing_flow ironing_spacing ironing_speed ironing_type layer_height line_width max_bridge_length",
  "max_travel_detour_distance min_bead_width min_feature_size min_width_top_surface",
  "minimum_sparse_infill_area only_one_wall_first_layer only_one_wall_top ooze_prevention",
  "outer_wall_acceleration outer_wall_jerk outer_wall_line_width outer_wall_speed overhang_1_4_speed",
  "overhang_2_4_speed overhang_3_4_speed overhang_4_4_speed overhang_speed_classic",
  "overhang_totally_speed post_process precise_outer_wall precise_z_height preheat_steps preheat_time",
  "prime_tower_brim_width prime_tower_width prime_volume print_flow_ratio print_sequence",
  "process_flow_support raft_contact_distance raft_expansion raft_first_layer_density",
  "raft_first_layer_expansion raft_layers reduce_crossing_wall reduce_infill_retraction renamed_from",
  "resolution role_based_wipe_speed seam_gap seam_position single_extruder_multi_material_priming",
  "skirt_distance skirt_height skirt_loops slice_closing_radius slicing_mode",
  "slowdown_for_curled_perimeters small_perimeter_speed small_perimeter_threshold smooth_coefficient",
  "sparse_infill_acceleration sparse_infill_density sparse_infill_line_width sparse_infill_pattern",
  "sparse_infill_speed spiral_mode standby_temperature_delta support_angle support_base_pattern",
  "support_base_pattern_spacing support_bottom_interface_spacing support_bottom_z_distance",
  "support_critical_regions_only support_expansion support_filament support_interface_bottom_layers",
  "support_interface_filament support_interface_loop_pattern support_interface_pattern",
  "support_interface_spacing support_interface_speed support_interface_top_layers support_line_width",
  "support_material_synchronize_layers support_object_xy_distance support_on_build_plate_only",
  "support_speed support_style support_threshold_angle support_top_z_distance support_type",
  "thick_bridges timelapse_type top_shell_layers top_shell_thickness top_solid_infill_flow_ratio",
  "top_surface_acceleration top_surface_jerk top_surface_line_width top_surface_pattern",
  "top_surface_speed travel_acceleration travel_jerk travel_speed tree_support_adaptive_layer_height",
  "tree_support_auto_brim tree_support_branch_angle tree_support_branch_diameter",
  "tree_support_branch_distance tree_support_brim_width tree_support_wall_count",
  "tree_support_with_infill wall_distribution_count wall_generator wall_infill_order wall_loops",
  "wall_transition_angle wall_transition_filter_deviation wall_transition_length wipe_on_loops",
  "wipe_speed wipe_tower_cone_angle wipe_tower_extra_rib_length wipe_tower_extra_spacing",
  "wipe_tower_filament wipe_tower_no_sparse_layers wipe_tower_rotation_angle wipe_tower_wall_type",
  "xy_contour_compensation xy_hole_compensation"
].join(" ").split(" ");

const NEVER = new Set([
  "print_settings_id", "inherits", "name", "from", "version", "is_custom_defined", "compatible_printers", "compatible_printers_condition",
  "print_compatible_printers", "printer_settings_id", "printer_model", "printer_variant", "curr_bed_type", "default_bed_type",
  "different_settings_to_system", "wipe_tower_x", "wipe_tower_y", "flush_volumes_matrix", "flush_volumes_vector", "flush_multiplier",
  "filament_colour", "filament_type", "filament_settings_id", "extruder_clearance_height_to_lid", "extruder_clearance_height_to_rod",
  "extruder_clearance_radius", "bed_exclude_area", "printable_area", "printable_height",
  "post_process", "filename_format", "description", "renamed_from", "setting_id", "instantiation"
]);
const TUNING_RE = /speed|accel|jerk|temperature|_delta$|timelapse|exclude_object|arc_fitting|ooze|flow|pressure|retract|z_hop|fan|cooling|slow_down|standby|gcode|travel|wipe|overhang_[0-9]|precise|resonance|smooth|junction|max_volumetric|extruder_clearance|spiral|role_base/;
// Process keys whose value is a filament slot ("0" = whatever is loaded).
const SLOT_KEYS = ["support_filament", "support_interface_filament"];

const arr = v => Array.isArray(v) ? v : (typeof v === "string" && v.includes(";") ? v.split(";") : (v == null ? [] : [v]));

// Which installed preset the template's process id means. Exact name, then
// the same name with "mm" after the number (OrcaSlicer 2.2 said "0.20
// Standard", Snapmaker Orca says "0.20mm Standard"), then a Standard preset
// for this printer and nozzle. names = preset names without ".json".
function resolveProcess(wanted, names, printerId) {
  wanted = String(wanted || "");
  if (!names || !names.length) return { id: wanted, how: "kept (no profile list)" };
  if (names.includes(wanted)) return { id: wanted, how: "exact" };
  const mm = wanted.replace(/^(\d+\.\d+)\s/, "$1mm ");
  if (names.includes(mm)) return { id: mm, how: "mm inserted" };
  const nozzle = (/\(([\d.]+) nozzle\)/.exec(printerId || "") || [])[1];
  const model = String(printerId || "").replace(/ \(.*$/, "");
  const cand = names.find(n => /Standard/.test(n) && n.includes("@" + model) && (!nozzle || n.includes("(" + nozzle + " nozzle)")));
  return cand ? { id: cand, how: "closest installed" } : { id: wanted, how: "not installed" };
}

// Snapmaker Orca's process presets, read from the install next to the exe.
// Async (the Hub never blocks on disk in a handler), cached per folder
// mtime. { dir, names, keys:Set, source: "installed" | "built-in" }.
const PROFILE_CACHE = new Map();
async function profiles(orcaExe) {
  const dir = path.join(path.dirname(String(orcaExe || "")), "resources", "profiles", "Snapmaker", "process");
  let st = null; try { st = await fs.promises.stat(dir); } catch {}
  if (!st || !st.isDirectory()) return { dir, names: [], keys: new Set(BUILTIN_KEYS), source: "built-in" };
  const hit = PROFILE_CACHE.get(dir);
  if (hit && hit.mtime === st.mtimeMs) return hit.value;
  const files = (await fs.promises.readdir(dir)).filter(f => /\.json$/i.test(f));
  const keys = new Set();
  await Promise.all(files.map(async f => {
    try { for (const k of Object.keys(JSON.parse(await fs.promises.readFile(path.join(dir, f), "utf8")))) keys.add(k); } catch {}
  }));
  const value = keys.size
    ? { dir, names: files.map(f => f.replace(/\.json$/i, "")), keys, source: "installed" }
    : { dir, names: [], keys: new Set(BUILTIN_KEYS), source: "built-in" };
  PROFILE_CACHE.set(dir, { mtime: st.mtimeMs, value });
  return value;
}

function settingsOf(entries, what) {
  const e = entries.find(x => x.name === PS);
  if (!e) throw new Error(what + " is not a project 3MF (no project_settings.config)");
  try { return JSON.parse(zipEntryContent(e).toString("utf8")); }
  catch { throw new Error(what + "'s project_settings.config is not valid JSON"); }
}
// Is this file already a U1 project? (Then there is nothing to convert.)
function isU1(srcBuf) {
  try { return String(settingsOf(zipRead(srcBuf), "file").printer_model || "") === U1; } catch { return false; }
}

// opts: { keys: Set of process keys, names: installed preset names }
function convert(srcBuf, tplBuf, opts) {
  opts = opts || {};
  const keys = opts.keys instanceof Set ? opts.keys : new Set(BUILTIN_KEYS);
  const src = zipRead(srcBuf), tpl = zipRead(tplBuf);
  const sp = settingsOf(src, "the file"), tp0 = settingsOf(tpl, "the U1 template");
  if (String(tp0.printer_model || "") !== U1) throw new Error("the U1 template is a project for " + (tp0.printer_model || "an unknown printer") + ", not the " + U1 + " - save one from Snapmaker Orca with the U1 selected");
  const from = String(sp.printer_model || sp.printer_settings_id || "unknown printer");
  if (String(sp.printer_model || "") === U1) return { already: true, printer: { from, to: U1 } };
  const tp = padFilamentArrays(JSON.parse(JSON.stringify(tp0)));
  const out = { ...tp };
  const carried = [], skipped = [];
  for (const k of Object.keys(sp)) {
    if (NEVER.has(k) || !keys.has(k) || TUNING_RE.test(k)) continue;
    if (!(k in tp)) { skipped.push(k); continue; }
    if (JSON.stringify(tp[k]) !== JSON.stringify(sp[k])) carried.push(k);
    out[k] = sp[k];
  }
  // A support filament past slot 4 does not exist here: back to "any".
  const notes = [];
  for (const k of SLOT_KEYS) if (Number(out[k]) > SLOTS) { notes.push(k + " was filament " + out[k] + ", set to default"); out[k] = "0"; }

  const colors = arr(sp.filament_colour).map(c => String(c || "").trim()).filter(Boolean);
  const types = arr(sp.filament_type).map(t => String(t || "").trim());
  const over4 = colors.length > SLOTS ? colors.length : 0;
  const pad = a => { a = a.slice(0, SLOTS); while (a.length && a.length < SLOTS) a.push(a[a.length - 1]); return a; };
  if (colors.length) out.filament_colour = pad(colors);
  const tt = arr(tp.filament_type);
  const mismatched = [];
  types.slice(0, Math.min(SLOTS, colors.length || types.length)).forEach((t, i) => {
    const mine = String(tt[i] || tt[tt.length - 1] || "");
    if (t && mine && t.toUpperCase() !== mine.toUpperCase()) mismatched.push({ slot: i + 1, was: t, now: mine });
  });
  // Orca's list of the project's own values per preset: process, one per
  // filament slot, printer. Carried keys show as the project's edits.
  out.different_settings_to_system = [carried.slice().sort().join(";")].concat(Array(SLOTS + 1).fill(""));
  const proc = resolveProcess(tp.print_settings_id, opts.names, tp.printer_settings_id);
  out.print_settings_id = proc.id;

  const changed = [];
  const entries = [];
  let remapped = 0;
  for (const e of src) {
    if (STALE_RE.test(e.name)) { changed.push("stripped " + e.name); continue; }
    if (e.name === PS) { entries.push(makeEntry(PS, Buffer.from(JSON.stringify(out, null, 4), "utf8"))); continue; }
    if (e.name === SI) {
      const xml = zipEntryContent(e).toString("utf8");
      const patched = xml.replace(/(<(?:header_item|metadata) key="printer_model_id" value=")[^"]*(")/g, "$1" + U1 + "$2");
      if (patched !== xml) { entries.push(makeEntry(SI, Buffer.from(patched, "utf8"))); changed.push("printer id in slice_info set to " + U1); continue; }
      entries.push(e); continue;
    }
    if (e.name === MS) {
      const xml = zipEntryContent(e).toString("utf8");
      const patched = xml.replace(/(<metadata key="extruder" value=")(\d+)("\s*\/>)/g, (all, a, n, b) => (+n >= 1 && +n <= SLOTS) ? all : (remapped++, a + "1" + b));
      if (patched !== xml) { entries.push(makeEntry(MS, Buffer.from(patched, "utf8"))); changed.push(remapped + " object extruder" + (remapped === 1 ? "" : "s") + " above " + SLOTS + " set to 1"); continue; }
      entries.push(e); continue;
    }
    entries.push(e);   // geometry, painting, thumbnails: original compressed bytes
  }
  return {
    already: false, buffer: zipWrite(entries),
    printer: { from, to: U1 }, process: proc,
    carried: carried.sort(), kept: families(carried, out), skipped: skipped.sort(), mismatched, over4, remapped, notes, changed
  };
}

// "<name> (U1).3mf" beside the original.
function outName(rel) { return String(rel).replace(/\.3mf$/i, "") + " (U1).3mf"; }

// A short human list of what the designer had that the U1 project keeps.
const FAMILIES = [
  [/prime_tower|enable_prime_tower/, "prime tower"], [/wall_loops|wall_generator|wall_distribution|wall_transition|wall_infill_order|only_one_wall/, "walls"],
  [/shell/, "top and bottom shells"], [/infill/, "infill"], [/support/, "supports"], [/brim|skirt|draft_shield/, "brim and skirt"],
  [/^layer_height|initial_layer_print_height|adaptive_layer/, "layer height"], [/seam/, "seam"], [/bridge/, "bridges"],
  [/ironing/, "ironing"], [/fuzzy/, "fuzzy skin"], [/raft/, "raft"], [/line_width/, "line widths"], [/print_sequence/, "print order"]
];
// ps (optional): the converted settings. A family whose only differences
// are sub-settings of a feature that is off (fuzzy skin distances with fuzzy
// skin off) is not something the designer "kept", so it is not listed.
const OFF = { "fuzzy skin": ["fuzzy_skin", "none"], "ironing": ["ironing_type", "no ironing"], "prime tower": ["enable_prime_tower", "0"], "supports": ["enable_support", "0"], "raft": ["raft_layers", "0"] };
function families(carried, ps) {
  const seen = new Set();
  for (const k of carried) {
    const f = FAMILIES.find(([re]) => re.test(k));
    seen.add(f ? f[1] : "other");
  }
  if (ps) for (const [name, [key, off]] of Object.entries(OFF))
    if (seen.has(name) && String(ps[key]) === off && !carried.includes(key)) seen.delete(name);
  const order = FAMILIES.map(f => f[1]).concat(["other"]);
  return [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

module.exports = { convert, isU1, resolveProcess, profiles, outName, families, BUILTIN_KEYS, NEVER, TUNING_RE, U1 };
