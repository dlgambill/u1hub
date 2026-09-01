// modules/resources.js — Resource Monitor (v2.16).
//
// Answers one question: "for everything Dispatch has scheduled, how much
// filament of each colour do I need, how much is on the shelf, and what do I
// have to buy?"
//
// Design notes, and why it looks like this:
//
//  * Parsing happens HERE, server-side, where the NAS is reachable. The browser
//    never sees a gcode file. Reads are head 64 KB + tail 512 KB — the config
//    block lives at the end of the file and the header block at the start, and
//    a scheduled library is ~220 files of 35-350 MB. Streaming them would be
//    minutes of SMB traffic per page load.
//
//  * The parse cache is keyed on (path, mtime, size), the same shape core uses
//    for PAL_CACHE. A re-slice changes mtime and size, so the key self-
//    invalidates; nothing has to be told to flush.
//
//  * Inventory (remaining / net weight / price / buy link) lives in
//    resources.json, NOT in spools.json. rfid.js owns spools.json and rewrites
//    it on every tag bind; adding columns there would mean two writers on one
//    file. Here the spool record stays the identity, and this file stays the
//    quantity, joined by spool id.
//
//  * PURGE IS NOT ADDED ANYWHERE. Verified 2026-08-31 against real Orca 2.3.5
//    output: an 88-tool-change job reconciles to 0.01 g and a 1002-tool-change
//    job to 0.01 g. Orca charges flush extrusion to the slot doing the purging,
//    so per-slot grams already include it. Adding a purge estimate on top would
//    double-count. parser.js keeps `unaccounted_g` as an integrity check only.

"use strict";

const fs = require("fs");
const path = require("path");
const { parseGcodeMap } = require("../parser.js");

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;

// Job states that count as "committed filament". Paused is included: a paused
// job is still on the board and its filament is still spoken for.
const COUNTED_STATES = new Set(["queued", "printing", "paused"]);

// Nearest-colour match ceiling. Above this dE2000 nothing is proposed at all —
// the colour lands in Unassigned rather than being silently attached to
// something that is not it. Below REVIEW_DE the match is treated as confident.
//
// These defaults were tuned against the real shelf (11 spools) and the real
// schedule (56 distinct colours) on 2026-08-31. A first pass at dE 25 produced
// confidently wrong rows — slicer blue #0080FF matched "Ash Gray" at 20.7 and
// pink #FF80FF matched "Orchid Rainbow" at 12.0. Neither is the same filament in
// any sense that helps someone shopping. At 10 the survivors are the ones that
// hold up by eye (#37383B -> Bambu Black at 2.8, #C0C0C0 -> Elegoo Clear at 3.1,
// #80FFFF -> Translucent Cyan at 4.7) and everything else goes to Unassigned,
// where a human decides. An honest "I don't know" beats a wrong shopping list.
// Overridable per-install via resources.json settings.match_de_max.
//
// Set to 7 (not 10) on the near-white evidence — see
// test/de-nearwhite-standalone.js. Pure white sits 14+ from every bone and
// flesh in the library, so white is never at risk. But the closest bone/flesh
// pair (#F8E1C2 vs #EAC9B0) is 7.3: the two families share lightness and
// yellowness and differ almost entirely on a* (flesh +8 to +11, bone -1 to +3),
// which dE2000 averages away. A ceiling of 7 puts that pair on the far side of
// the line while keeping every match that holds up by eye (Bambu Black 2.8,
// Elegoo Clear 3.1, Translucent Cyan 4.7). Bones still merge with bones at
// 2.5-5.6, which is correct — that is batch variation, not a different spool.
const DEFAULT_MATCH_DE_MAX = 7;
const REVIEW_DE = 3;

// ---- colour maths -----------------------------------------------------------
function hexToRgb(hex) {
  if (!hex) return null;
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function normHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}
// sRGB -> CIELAB (D65). Only used when a spool has no measured `lab`; measured
// values from the swatch library are always preferred.
function rgbToLab(rgb) {
  if (!rgb) return null;
  const f = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = rgb.map(f);
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / 1.00000;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const t = v => v > 0.008856 ? Math.cbrt(v) : (7.787 * v + 16 / 116);
  const fx = t(X), fy = t(Y), fz = t(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
// CIEDE2000. Worth the ~30 lines over CIE76 here: the failure mode we care
// about is "is this slicer placeholder the same as that spool", and CIE76
// badly overstates distance in the blues and understates it in near-neutrals,
// which is exactly where filament placeholders live (#00FF00, #888888).
function deltaE2000(l1, l2) {
  if (!l1 || !l2) return Infinity;
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2;
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (b, ap) => { if (b === 0 && ap === 0) return 0; const h = Math.atan2(b, ap) * deg; return h >= 0 ? h : h + 360; };
  const hp1 = hp(b1, ap1), hp2 = hp(b2, ap2);
  const dLp = L2 - L1, dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (Cp1 + Cp2) / 2;
  let hbp;
  if (Cp1 * Cp2 === 0) hbp = hp1 + hp2;
  else {
    hbp = hp1 + hp2;
    if (Math.abs(hp1 - hp2) > 180) hbp += (hbp < 360 ? 360 : -360);
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos((2 * hbp) * rad)
              + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTh = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTh * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2)
                   + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---- resources.json (inventory + colour map) ---------------------------------
// State file. Never committed — see CLAUDE.md rule #5.
function emptyState() {
  return { inv: {}, color_map: {},
           settings: { assume_empty_when_unset: false, match_de_max: DEFAULT_MATCH_DE_MAX } };
}
function makeStore(baseDir, hublog) {
  const file = path.join(baseDir, "resources.json");
  let S = emptyState();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
      S = Object.assign(emptyState(), raw);
      S.inv = S.inv || {};
      S.color_map = S.color_map || {};
      S.settings = Object.assign(emptyState().settings, S.settings || {});
    }
  } catch (e) { hublog("error", "resources.json unreadable, starting empty: " + e.message); }
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify(S, null, 2)); }
    catch (e) { hublog("error", "resources.json save failed: " + e.message); }
  };
  return { get state() { return S; }, save, file };
}

// ---- spool shelf --------------------------------------------------------------
// Two populations live in spools.json and both are real filament on a shelf:
//   spools{}  RFID-bound, id "sp_...", carries measured `lab` when the swatch
//             library had it
//   local[]   manually added, negative numeric id
// They are joined here into one list with a string id, then decorated with the
// inventory numbers this module owns.
function readShelf(baseDir, store) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(baseDir, "spools.json"), "utf8")) || {}; }
  catch { raw = {}; }
  const out = [];
  const add = (id, s, source) => {
    if (!s) return;
    const hex = normHex(s.hex);
    const hexes = Array.isArray(s.hexes) ? s.hexes.map(normHex).filter(Boolean) : [];
    const inv = (store.state.inv || {})[id] || {};
    out.push({
      id,
      source,
      brand: s.brand || "",
      material: String(s.material || "").trim(),
      material_variant: String(s.material_variant || "").trim(),
      color_name: s.color_name || "",
      color_hex: hex,
      color_hexes: hexes.length ? hexes : (hex ? [hex] : []),
      color_style: s.color_style || null,
      lab: Array.isArray(s.lab) && s.lab.length === 3 ? s.lab : null,
      // --- inventory, owned by resources.json ---
      remaining_g: inv.remaining_g == null ? null : Number(inv.remaining_g),
      net_weight_g: inv.net_weight_g == null ? 1000 : Number(inv.net_weight_g),
      cost_per_roll: inv.cost_per_roll == null ? null : Number(inv.cost_per_roll),
      purchase_url: inv.purchase_url || "",
      diameter_mm: inv.diameter_mm == null ? 1.75 : Number(inv.diameter_mm),
      density: inv.density == null ? null : Number(inv.density),
      active: inv.active === false ? false : true,
      notes: inv.notes || ""
    });
  };
  for (const [id, s] of Object.entries(raw.spools || {})) add(id, s, "rfid");
  for (const s of (raw.local || [])) if (s && s.id != null) add(String(s.id), s, "local");
  return out;
}
// Lab for a spool: measured when we have it, otherwise derived from the hex.
function spoolLabs(sp) {
  if (sp.lab) return [sp.lab];
  return sp.color_hexes.map(h => rgbToLab(hexToRgb(h))).filter(Boolean);
}

// ---- parse cache ---------------------------------------------------------------
// Key: "<slug>:<name>" -> { size, mtime, slots[] }. A re-slice changes size and
// mtime, so the entry self-invalidates. Head+tail read only.
function makeParseCache(hublog) {
  const CACHE = new Map();
  function readEnds(fp, size) {
    if (size <= HEAD_BYTES + TAIL_BYTES) return fs.readFileSync(fp, "utf8");
    const fd = fs.openSync(fp, "r");
    try {
      const h = Buffer.alloc(HEAD_BYTES);
      fs.readSync(fd, h, 0, HEAD_BYTES, 0);
      const t = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, t, 0, TAIL_BYTES, size - TAIL_BYTES);
      return h.toString("utf8") + "\n" + t.toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  // Returns { ok:true, slots } or { ok:false, reason } — never throws, because a
  // single unreadable file must not take out the whole rollup.
  function slotsFor(slug, name, fp) {
    let st;
    try { st = fs.statSync(fp); }
    catch (e) { return { ok: false, reason: e.code === "ENOENT" ? "file not found" : ("stat failed: " + e.message) }; }
    const key = slug + ":" + name;
    const hit = CACHE.get(key);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return { ok: true, slots: hit.slots, cached: true };
    let r;
    try { r = parseGcodeMap(readEnds(fp, st.size), { scanBody: false }); }
    catch (e) { return { ok: false, reason: "parse failed: " + e.message }; }
    const a = r.amounts || { slots: [] };
    if (!a.have_grams) return { ok: false, reason: "no filament amounts in file" };
    const slots = [];
    for (const s of a.slots) {
      if (!(s.grams > 0)) continue;              // slot configured but not printed
      const pal = (r.palette || [])[s.i] || {};
      slots.push({
        slot_index: s.i,
        filament_type: (pal.type || "").trim() || "PLA",
        color_hex: normHex(pal.hex) || null,
        grams: s.grams,
        length_mm: s.length_mm,
        slicer_cost: s.slicer_cost,
        grams_derived: !!s.grams_derived
      });
    }
    const rec = { size: st.size, mtime: st.mtimeMs, slots,
                  unaccounted_g: a.unaccounted_g, parsed_at: Date.now() };
    CACHE.set(key, rec);
    if (a.suspect_unaccounted)
      hublog("warn", "resources: " + name + " slot sum and total differ by " +
             a.unaccounted_g + " g — unexpected for Orca, check the slicer");
    return { ok: true, slots, cached: false };
  }
  return { slotsFor, size: () => CACHE.size, clear: () => CACHE.clear(), CACHE };
}

// ---- spool matching ------------------------------------------------------------
// Order: explicit map -> exact hex (same material) -> nearest dE2000. Anything
// past MATCH_DE_MAX is left unmatched rather than guessed at.
function matchSpool(hex, material, shelf, colorMap, deMax) {
  const MATCH_DE_MAX = deMax > 0 ? deMax : DEFAULT_MATCH_DE_MAX;
  const mapped = colorMap[hex];
  if (mapped) {
    const sp = shelf.find(s => s.id === String(mapped));
    if (sp) return { spool: sp, how: "mapped", de: 0, review: false };
    // The map points at a spool that is no longer on the shelf — forgotten,
    // rebound, or replaced with a different brand. Falling through to
    // nearest-match here is the wrong answer twice over: it silently discards a
    // decision a human made on purpose, and at a tight dE ceiling it usually
    // finds nothing, so the row renders "unassigned" as if it had never been
    // mapped at all. Found live on 2026-08-31 — a Bambu Black was swapped for an
    // Overture Black, and the row's 600 g and $25 vanished with no explanation
    // anywhere in the UI. Say what happened instead.
    return { spool: null, how: "orphan", de: null, review: true, orphan_id: String(mapped) };
  }
  const sameMat = shelf.filter(s => s.active &&
    (!material || !s.material || s.material.toUpperCase() === material.toUpperCase()));
  const pool = sameMat.length ? sameMat : shelf.filter(s => s.active);
  const exact = pool.find(s => s.color_hexes.includes(hex));
  if (exact) return { spool: exact, how: "exact", de: 0, review: false };
  const target = rgbToLab(hexToRgb(hex));
  let best = null, bestDe = Infinity;
  for (const sp of pool) {
    for (const lab of spoolLabs(sp)) {
      const de = deltaE2000(target, lab);
      if (de < bestDe) { bestDe = de; best = sp; }
    }
  }
  if (best && bestDe <= MATCH_DE_MAX)
    return { spool: best, how: "nearest", de: +bestDe.toFixed(2), review: bestDe > REVIEW_DE };
  return { spool: null, how: "none", de: best ? +bestDe.toFixed(2) : null, review: true };
}

// ---- rollup ---------------------------------------------------------------------
function rollup(opts) {
  const { jobs, shelf, store, cache, folderFor, deadlineOnly, from, to } = opts;
  const settings = store.state.settings || {};
  const colorMap = store.state.color_map || {};
  const assumeEmpty = !!settings.assume_empty_when_unset;

  const buckets = new Map();   // "MAT|#HEX" -> row
  const unresolved = [];
  const counted = [];
  let totalUnits = 0;

  for (const job of (jobs || [])) {
    if (!job || !COUNTED_STATES.has(String(job.state))) continue;
    if (deadlineOnly && !(job.deadline > 0)) continue;
    if (from != null && job.deadline > 0 && job.deadline < from) continue;
    if (to != null && job.deadline > 0 && job.deadline > to) continue;
    // `remaining` is what is still owed; qty is the original order. Using qty
    // would re-buy filament for copies that have already printed.
    const units = Number.isFinite(job.remaining) ? job.remaining
                : (Number.isFinite(job.qty) ? job.qty : 1);
    if (units <= 0) continue;

    const slug = String(job.type || "u1");
    let dir = null;
    try { dir = folderFor(slug); } catch { dir = null; }
    if (!dir) { unresolved.push({ job: job.id, file: job.file, units, reason: "no folder for type '" + slug + "'" }); continue; }
    const fp = path.join(dir, path.basename(String(job.file || "")));
    const r = cache.slotsFor(slug, job.file, fp);
    if (!r.ok) { unresolved.push({ job: job.id, file: job.file, units, reason: r.reason }); continue; }

    totalUnits += units;
    counted.push({ job: job.id, file: job.file, units, slots: r.slots.length });
    for (const s of r.slots) {
      const hex = s.color_hex || "#888888";
      const mat = (s.filament_type || "PLA").toUpperCase();
      const key = mat + "|" + hex;
      let row = buckets.get(key);
      if (!row) {
        row = { material: mat, color_hex: hex, needed_g: 0, jobs: [], derived: false };
        buckets.set(key, row);
      }
      row.needed_g += s.grams * units;
      row.derived = row.derived || s.grams_derived;
      row.jobs.push({ job: job.id, file: job.file, units, slot: s.slot_index, grams_each: s.grams });
    }
  }
  return { buckets, unresolved, counted, totalUnits, shelf, colorMap, assumeEmpty,
           deMax: settings.match_de_max > 0 ? settings.match_de_max : DEFAULT_MATCH_DE_MAX };
}

// Turn buckets into the shape the table renders, and total it up.
function buildRows(agg) {
  const { buckets, shelf, colorMap, assumeEmpty, deMax } = agg;
  const rows = [];
  for (const row of buckets.values()) {
    const m = matchSpool(row.color_hex, row.material, shelf, colorMap, deMax);
    const sp = m.spool;
    const needed = +row.needed_g.toFixed(2);

    // on-hand is genuinely unknown until Danny fills it in. Unknown is NOT
    // zero: reporting a shortfall against a number nobody entered would invent
    // a shopping list. The Resources tab offers `assume_empty_when_unset` for
    // the deliberate worst-case view instead.
    const known = sp && sp.remaining_g != null;
    const onHand = known ? sp.remaining_g : (assumeEmpty ? 0 : null);

    let shortfall = null, rolls = null, cost = null;
    if (onHand != null) {
      shortfall = Math.max(0, +(needed - onHand).toFixed(2));
      const net = sp && sp.net_weight_g > 0 ? sp.net_weight_g : 1000;
      rolls = shortfall > 0 ? Math.ceil(shortfall / net) : 0;
      // Never assume a price. No cost_per_roll -> rolls still shown, cost blank,
      // and the row is excluded from the spend total with a note.
      if (rolls > 0 && sp && sp.cost_per_roll != null) cost = +(rolls * sp.cost_per_roll).toFixed(2);
    }

    rows.push({
      material: row.material,
      color_hex: row.color_hex,
      needed_g: needed,
      grams_derived: row.derived,
      spool_id: sp ? sp.id : null,
      spool_name: sp ? ([sp.brand, sp.material_variant || sp.material, sp.color_name].filter(Boolean).join(" ")) : null,
      spool_hex: sp ? sp.color_hex : null,
      spool_hexes: sp ? sp.color_hexes : [],
      match: m.how, match_de: m.de, needs_review: !!m.review && m.how !== "mapped",
      orphan_of: m.orphan_id || null,
      on_hand_g: onHand,
      on_hand_known: !!known,
      net_weight_g: sp && sp.net_weight_g > 0 ? sp.net_weight_g : 1000,
      cost_per_roll: sp ? sp.cost_per_roll : null,
      purchase_url: sp ? sp.purchase_url : "",
      shortfall_g: shortfall,
      rolls_to_buy: rolls,
      est_cost: cost,
      no_price: rolls > 0 && (!sp || sp.cost_per_roll == null),
      unassigned: !sp,
      job_count: row.jobs.length,
      jobs: row.jobs
    });
  }
  // Shortfall first, then biggest need. Unknown-on-hand sorts with the shortfalls
  // because it is the other thing needing attention, not a settled row.
  rows.sort((a, b) => {
    const rank = r => (r.shortfall_g > 0 ? 0 : (r.on_hand_g == null ? 1 : 2));
    const d = rank(a) - rank(b);
    return d !== 0 ? d : b.needed_g - a.needed_g;
  });

  const totals = {
    colors: rows.length,
    needed_g: +rows.reduce((a, r) => a + r.needed_g, 0).toFixed(2),
    shortfall_g: +rows.reduce((a, r) => a + (r.shortfall_g || 0), 0).toFixed(2),
    rolls_to_buy: rows.reduce((a, r) => a + (r.rolls_to_buy || 0), 0),
    est_cost: +rows.reduce((a, r) => a + (r.est_cost || 0), 0).toFixed(2),
    short_colors: rows.filter(r => r.shortfall_g > 0).length,
    unpriced_rows: rows.filter(r => r.no_price).length,
    unknown_on_hand: rows.filter(r => r.on_hand_g == null).length,
    unassigned: rows.filter(r => r.unassigned && r.match !== "orphan").length,
    orphaned: rows.filter(r => r.match === "orphan").length,
    review: rows.filter(r => r.needs_review && !r.unassigned).length
  };
  return { rows, totals };
}

// ---- module -----------------------------------------------------------------------
function register(ctx) {
  const { app, express, hublog } = ctx;
  const store = makeStore(ctx.baseDir, hublog);
  const cache = makeParseCache(hublog);

  const num = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const jobsNow = () => {
    const get = ctx.use("dispatch.jobs");
    return typeof get === "function" ? (get() || []) : null;
  };

  function compute(q) {
    const jobs = jobsNow();
    if (jobs === null) return { error: "Dispatch is off — there is no schedule to price." };
    const shelf = readShelf(ctx.baseDir, store);
    // Inventory rows whose spool no longer exists. Harmless to the maths — the
    // rollup only reads inventory through a matched spool — but they are a
    // person's typed-in grams and price sitting in a file with nothing pointing
    // at them, so they get reported rather than left to rot silently.
    const shelfIds = new Set(shelf.map(s => s.id));
    const orphaned_inv = Object.entries(store.state.inv || {})
      .filter(([id]) => !shelfIds.has(id))
      .map(([id, v]) => ({ spool_id: id, remaining_g: v.remaining_g ?? null,
                           cost_per_roll: v.cost_per_roll ?? null }));
    const agg = rollup({
      jobs, shelf,
      store, cache,
      folderFor: slug => ctx.gcodeFolderFor(slug),
      deadlineOnly: String(q.deadline_only || "") === "1",
      from: num(q.from),
      to: num(q.to)
    });
    const { rows, totals } = buildRows(agg);
    return {
      rows, totals, orphaned_inv,
      unresolved: agg.unresolved,
      counted_jobs: agg.counted.length,
      counted_units: agg.totalUnits,
      settings: store.state.settings,
      cache_entries: cache.size(),
      generated_at: Date.now()
    };
  }

  // GET /api/resources — the whole rollup.
  //   ?deadline_only=1   only jobs that carry a deadline
  //   ?from=&to=         epoch ms bounds, applied to deadline when one is set
  app.get("/api/resources", (req, res) => {
    try {
      const out = compute(req.query || {});
      if (out.error) return res.status(409).json(out);
      res.json(out);
    } catch (e) {
      hublog("error", "resources rollup failed: " + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/resources/spools — shelf + inventory, for the Spools tab columns.
  app.get("/api/resources/spools", (req, res) => {
    try { res.json({ spools: readShelf(ctx.baseDir, store) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/resources/inventory { spool_id, ...fields } — inline edits from
  // the Spools tab. Only the whitelisted keys are writable; anything else in the
  // body is ignored rather than silently stored.
  const INV_NUM = ["remaining_g", "net_weight_g", "cost_per_roll", "diameter_mm", "density"];
  const INV_STR = ["purchase_url", "notes"];
  app.post("/api/resources/inventory", express.json ? express.json() : (q, s, n) => n(), (req, res) => {
    const b = req.body || {};
    const id = String(b.spool_id || "").trim();
    if (!id) return res.status(400).json({ error: "Body needs { spool_id }" });
    const inv = store.state.inv[id] || (store.state.inv[id] = {});
    for (const k of INV_NUM) {
      if (!(k in b)) continue;
      if (b[k] === null || b[k] === "") { delete inv[k]; continue; }
      const n = parseFloat(b[k]);
      if (isNaN(n) || n < 0) return res.status(400).json({ error: k + " must be a non-negative number" });
      inv[k] = n;
    }
    for (const k of INV_STR) if (k in b) inv[k] = String(b[k] || "");
    if ("active" in b) inv.active = !!b.active;
    store.save();
    res.json({ ok: true, spool_id: id, inv });
  });

  // POST /api/resources/map { color_hex, spool_id } — pin a slicer hex to a
  // spool. spool_id null clears the pin.
  app.post("/api/resources/map", express.json ? express.json() : (q, s, n) => n(), (req, res) => {
    const b = req.body || {};
    const hex = normHex(b.color_hex);
    if (!hex) return res.status(400).json({ error: "Body needs a valid { color_hex }" });
    if (b.spool_id === null || b.spool_id === "") delete store.state.color_map[hex];
    else store.state.color_map[hex] = String(b.spool_id);
    store.save();
    res.json({ ok: true, color_map: store.state.color_map });
  });

  // POST /api/resources/settings { assume_empty_when_unset }
  app.post("/api/resources/settings", express.json ? express.json() : (q, s, n) => n(), (req, res) => {
    const b = req.body || {};
    if ("assume_empty_when_unset" in b)
      store.state.settings.assume_empty_when_unset = !!b.assume_empty_when_unset;
    store.save();
    res.json({ ok: true, settings: store.state.settings });
  });

  // Badge for the Schedule page: "N colors short". Deliberately the same code
  // path as the table — a badge that disagrees with the tab it links to is
  // worse than no badge.
  app.get("/api/resources/badge", (req, res) => {
    try {
      const out = compute({});
      if (out.error) return res.json({ short: 0, off: true });
      res.json({
        short: out.totals.short_colors,
        unknown: out.totals.unknown_on_hand,
        unassigned: out.totals.unassigned,
        unresolved: out.unresolved.length,
        est_cost: out.totals.est_cost
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  ctx.provide("resources.rollup", q => compute(q || {}));
}

module.exports = { register, deltaE2000, rgbToLab, hexToRgb, normHex,
                   matchSpool, rollup, buildRows, COUNTED_STATES };
