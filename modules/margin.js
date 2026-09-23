// modules/margin.js — is this plate worth printing? (v2.28)
//
// Danny's selection rule for SF3D, applied to every gcode the Hub can see:
// filament under $0.02 a gram, sell for at least $0.12 a gram, or don't print
// it - and lately, watch how long it ties up a printer. The Hub already knows
// the two inputs from the file itself (grams from the slicer's filament
// totals, hours from its time estimate) and one from the file name (the
// per-plate quantity, "GuineaPigs x24.gcode"), so the arithmetic is free:
//
//   cost to print       = grams x cost per gram
//   minimum for the plate = grams x sell floor per gram
//   minimum per unit    = that / quantity            (when the name says how many)
//   per printer hour    = minimum for the plate / hours
//
// Three numbers on the job card, no price to type. Both rates are settings,
// because every farm's rule of thumb is its own; the defaults are Danny's.
// This module never decides anything - Dispatch does not consult it - it
// only shows the number so the person choosing what to print sees it.
//
// v2.29: the other direction. The line above says what a plate MUST sell
// for; a box beside it takes what a piece ACTUALLY sells for and turns that
// into dollars per printer hour, dollars per gram, and the margin over
// filament. Save keeps one row per file in margin.json, and a table sorted
// by those numbers shows which files carry the farm and which ones only
// keep it busy. Danny: "so that I can look and see what is most and least
// profitable."

"use strict";

const fs = require("fs");
const path = require("path");
const { estMinutes } = require("../parser.js");

const DEFAULTS = Object.freeze({ sell_per_g: 0.12, cost_per_g: 0.02 });
const TABLE_MAX = 2000;

// "Baby Elephant x24.gcode" -> 24; "24x penguin" -> 24; "x2" -> 2; nothing -> null.
// Word-bounded so "box20" and "Onyx 3" do not count.
function qtyFromName(name) {
  const s = String(name || "").replace(/\.gcode$/i, "");
  let m = /(?:^|[\s_\-(\[])[x×]\s?(\d{1,3})(?=$|[\s_\-)\].,])/i.exec(s);
  if (m) return Number(m[1]);
  m = /(?:^|[\s_\-(\[])(\d{1,3})\s?[x×](?=$|[\s_\-)\].,])/i.exec(s);
  return m ? Number(m[1]) : null;
}

const r2 = v => Math.round(v * 100) / 100;

// Pure. grams: number | null; minutes: number | null; name: file name.
function quote({ grams, minutes, name, sell_per_g, cost_per_g }) {
  const sell = Number.isFinite(sell_per_g) ? sell_per_g : DEFAULTS.sell_per_g;
  const cost = Number.isFinite(cost_per_g) ? cost_per_g : DEFAULTS.cost_per_g;
  const g = Number.isFinite(grams) && grams > 0 ? grams : null;
  const min = Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  const qty = qtyFromName(name);
  const out = { grams: g, minutes: min, hours: min != null ? r2(min / 60) : null, qty, sell_per_g: sell, cost_per_g: cost,
                cost: null, min_plate: null, min_unit: null, per_hour: null };
  if (g == null) return out;
  out.cost = r2(g * cost);
  out.min_plate = r2(g * sell);
  if (qty) out.min_unit = r2(g * sell / qty);
  if (min != null) out.per_hour = r2(g * sell / (min / 60));
  return out;
}

// Pure. What a plate earns at the price a piece actually sells for. A file
// with no count in its name is one piece, so "price" is the plate's price.
// per_g is revenue per gram of filament, the number the sell floor is set in.
function actual({ grams, minutes, name, price, sell_per_g, cost_per_g }) {
  const q = quote({ grams, minutes, name, sell_per_g, cost_per_g });
  const p = Number(price);
  const out = { ...q, price: Number.isFinite(p) && p >= 0 ? r2(p) : null, pieces: q.qty || 1,
                revenue: null, actual_per_hour: null, actual_per_g: null, margin: null, margin_pct: null, below_floor: null };
  if (out.price == null || q.grams == null) return out;
  out.revenue = r2(out.price * out.pieces);
  out.actual_per_g = r2(out.revenue / q.grams);
  if (q.minutes != null) out.actual_per_hour = r2(out.revenue / (q.minutes / 60));
  out.margin = r2(out.revenue - q.cost);
  out.margin_pct = out.revenue > 0 ? Math.round(out.margin / out.revenue * 100) : null;
  out.below_floor = out.actual_per_g < q.sell_per_g;
  return out;
}

function register(ctx) {
  // ---- the price table (v2.29): one row per file, keyed by type:name -----
  const FILE = path.join(ctx.baseDir, "margin.json");
  let ROWS = {};
  try { ROWS = JSON.parse(fs.readFileSync(FILE, "utf8")).prices || {}; } catch {}
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify({ prices: ROWS }, null, 2)); } catch {} };
  const rowKey = (slug, name) => String(slug || "u1") + ":" + String(name || "");
  const conf = () => {
    const c = (ctx.cfg && typeof ctx.cfg.margin === "object" && ctx.cfg.margin) || {};
    return {
      sell_per_g: Number.isFinite(Number(c.sell_per_g)) && Number(c.sell_per_g) > 0 ? Number(c.sell_per_g) : DEFAULTS.sell_per_g,
      cost_per_g: Number.isFinite(Number(c.cost_per_g)) && Number(c.cost_per_g) >= 0 ? Number(c.cost_per_g) : DEFAULTS.cost_per_g
    };
  };

  ctx.app.get("/api/margin", (req, res) => res.json({ ...conf(), defaults: DEFAULTS }));

  ctx.app.post("/api/margin/settings", (req, res) => {
    const b = req.body || {};
    const next = { ...((ctx.cfg.margin && typeof ctx.cfg.margin === "object") ? ctx.cfg.margin : {}) };
    for (const k of ["sell_per_g", "cost_per_g"]) {
      if (!(k in b)) continue;
      if (b[k] === "" || b[k] == null) { delete next[k]; continue; }
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ error: k + " must be a dollar amount per gram, like 0.12" });
      if (k === "sell_per_g" && v === 0) return res.status(400).json({ error: "sell_per_g must be above zero" });
      next[k] = v;
    }
    ctx.cfg.margin = next;
    ctx.saveConfig();
    res.json({ ...conf(), defaults: DEFAULTS });
  });

  // GET /api/margin/quote?grams=..&est=<slicer time string or minutes>&name=..
  // The client already holds grams and the time string from /api/map; this
  // keeps the arithmetic in one place.
  ctx.app.get("/api/margin/quote", (req, res) => {
    const q = req.query || {};
    const grams = q.grams === "" || q.grams == null ? null : Number(q.grams);
    let minutes = null;
    if (q.est != null && q.est !== "") minutes = /^\d+(\.\d+)?$/.test(String(q.est)) ? Number(q.est) : estMinutes(String(q.est));
    res.json(quote({ grams, minutes, name: String(q.name || ""), ...conf() }));
  });

  // v2.29: what a piece actually sells for. Saves one row per file (the
  // latest price wins) with the numbers that came out of it, so the table
  // is a plain list and never recomputed from files that may have changed.
  // Body: { file, type?, price, grams, est|minutes }. The client sends the
  // grams and time it already holds from /api/map.
  ctx.app.post("/api/margin/price", (req, res) => {
    const b = req.body || {};
    const name = path.basename(String(b.file || ""));
    if (!name) return res.status(400).json({ error: "Body needs { file }" });
    const price = Number(b.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) return res.status(400).json({ error: "price must be a dollar amount per piece, like 5 or 4.50" });
    const grams = b.grams === "" || b.grams == null ? null : Number(b.grams);
    let minutes = null;
    if (b.minutes != null && b.minutes !== "") minutes = Number(b.minutes);
    else if (b.est != null && b.est !== "") minutes = /^\d+(\.\d+)?$/.test(String(b.est)) ? Number(b.est) : estMinutes(String(b.est));
    if (!Number.isFinite(grams) || grams <= 0) return res.status(400).json({ error: "This file has no filament total to price against" });
    const a = actual({ grams, minutes, name, price, ...conf() });
    const slug = String(b.type || "u1");
    const row = { file: name, type: slug, at: Date.now(), price: a.price, pieces: a.pieces, grams: a.grams, hours: a.hours,
                  cost: a.cost, revenue: a.revenue, per_hour: a.actual_per_hour, per_g: a.actual_per_g, margin: a.margin, margin_pct: a.margin_pct,
                  min_unit: a.min_unit, sell_per_g: a.sell_per_g, cost_per_g: a.cost_per_g, below_floor: a.below_floor };
    ROWS[rowKey(slug, name)] = row;
    const keys = Object.keys(ROWS);
    if (keys.length > TABLE_MAX) keys.sort((x, y) => ROWS[x].at - ROWS[y].at).slice(0, keys.length - TABLE_MAX).forEach(k => delete ROWS[k]);
    save();
    res.json({ ok: true, row });
  });
  ctx.app.post("/api/margin/price/remove", (req, res) => {
    const b = req.body || {};
    const k = rowKey(b.type, path.basename(String(b.file || "")));
    const had = k in ROWS;
    delete ROWS[k]; save();
    res.json({ ok: true, removed: had });
  });
  // GET /api/margin/table?type=u1&sort=per_hour|per_g|margin|revenue|price|at&file=<one>
  ctx.app.get("/api/margin/table", (req, res) => {
    const q = req.query || {};
    const slug = q.type ? String(q.type) : null;
    if (q.file) { const row = ROWS[rowKey(slug || "u1", path.basename(String(q.file)))] || null; return res.json({ row }); }
    const sort = ["per_hour", "per_g", "margin", "revenue", "price", "at", "hours"].includes(String(q.sort)) ? String(q.sort) : "per_hour";
    const rows = Object.values(ROWS).filter(r => !slug || r.type === slug)
      .sort((a, b) => ((b[sort] == null ? -Infinity : b[sort]) - (a[sort] == null ? -Infinity : a[sort])) || a.file.localeCompare(b.file));
    const c = conf();
    res.json({ rows, sort, count: rows.length, sell_per_g: c.sell_per_g, cost_per_g: c.cost_per_g,
               totals: rows.length ? { revenue: r2(rows.reduce((s, r) => s + (r.revenue || 0), 0)), margin: r2(rows.reduce((s, r) => s + (r.margin || 0), 0)), hours: r2(rows.reduce((s, r) => s + (r.hours || 0), 0)) } : null });
  });

  ctx.provide("margin.quote", (args) => quote({ ...args, ...conf() }));
  ctx.provide("margin.table", () => Object.values(ROWS));
}

module.exports = { register, quote, actual, qtyFromName, DEFAULTS };
