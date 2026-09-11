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

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseGcodeMap, parseConfig } = require("../parser.js");

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

// ---- file brief -------------------------------------------------------------
function readEnds(fp) {
  const st = fs.statSync(fp);
  if (st.size <= HEAD_BYTES + TAIL_BYTES) return { text: fs.readFileSync(fp, "utf8"), size: st.size, mtime: st.mtimeMs };
  const fd = fs.openSync(fp, "r");
  try {
    const h = Buffer.alloc(HEAD_BYTES); fs.readSync(fd, h, 0, HEAD_BYTES, 0);
    const t = Buffer.alloc(TAIL_BYTES); fs.readSync(fd, t, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    return { text: h.toString("utf8") + "\n" + t.toString("utf8"), size: st.size, mtime: st.mtimeMs };
  } finally { fs.closeSync(fd); }
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
  let CACHE = [];
  try { CACHE = JSON.parse(fs.readFileSync(FILE, "utf8")).reviews || []; } catch {}
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ reviews: CACHE }, null, 2)); } catch {} };

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
      last: CACHE.length ? { at: CACHE[CACHE.length - 1].at, file: CACHE[CACHE.length - 1].file, verdict: CACHE[CACHE.length - 1].verdict } : null,
      spent_usd: Math.round(CACHE.reduce((a, r) => a + (r.cost || 0), 0) * 100) / 100
    };
  }

  async function ask(c, userText, maxTokens) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(c.url + "/v1/messages", {
        method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", "x-api-key": c.key, "anthropic-version": API_VERSION },
        body: JSON.stringify({ model: c.model, max_tokens: maxTokens || 700, system: SYSTEM, messages: [{ role: "user", content: userText }] })
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
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "That file is not in the Hub library: " + name });
    const idx = Number(b.printer);
    const p = Number.isInteger(idx) ? (ctx.printers || [])[idx] : null;
    if (!p) return res.status(400).json({ error: "Pick the printer you are about to send this to" });
    if (BUSY) return res.status(409).json({ error: "A review is already running" });
    BUSY = true;
    try {
      const ends = readEnds(fp);
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
      const r = await ask(c, userText, 700);
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
  ctx.app.get("/api/advisor/brief", (req, res) => {
    const name = path.basename(String(req.query.file || ""));
    const slug = String(req.query.type || "u1");
    const fp = path.join(ctx.gcodeFolderFor(slug), name);
    if (!name || !fs.existsSync(fp)) return res.status(404).json({ error: "file not in the library" });
    try {
      const fb = briefFromText(readEnds(fp).text, name);
      const idx = Number(req.query.printer);
      const p = Number.isInteger(idx) ? (ctx.printers || [])[idx] : null;
      const pb = p ? printerBrief(p, idx, ctx.loadout ? ctx.loadout(idx) : [], null, null) : [];
      res.type("text/plain").send(fb.lines.concat([""], pb).join("\n"));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  ctx.provide("advisor.state", () => view());
}

module.exports = { register, briefFromText, printerBrief, parseVerdict, estimateCost, MODELS, MODEL_DEFAULT, SETTING_KEYS, SYSTEM };
