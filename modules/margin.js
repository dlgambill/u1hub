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

"use strict";

const { estMinutes } = require("../parser.js");

const DEFAULTS = Object.freeze({ sell_per_g: 0.12, cost_per_g: 0.02 });

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

function register(ctx) {
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

  ctx.provide("margin.quote", (args) => quote({ ...args, ...conf() }));
}

module.exports = { register, quote, qtyFromName, DEFAULTS };
