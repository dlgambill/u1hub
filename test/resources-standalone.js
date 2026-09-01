// test/resources-standalone.js — drives modules/resources.js against the REAL
// dispatch.json / spools.json / gcode library, with a stub ctx. No server, no
// browser. This is the live gate for the rollup: the numbers it prints are the
// numbers the Resources tab will show.
//   node test/resources-standalone.js
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("../modules/resources.js");

const BASE = path.join(__dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(BASE, "config.json"), "utf8"));
const D = JSON.parse(fs.readFileSync(path.join(BASE, "dispatch.json"), "utf8"));

const routes = {};
const ctx = {
  app: {
    get: (p, ...h) => { routes["GET " + p] = h[h.length - 1]; },
    post: (p, ...h) => { routes["POST " + p] = h[h.length - 1]; }
  },
  express: { json: () => (q, s, n) => n() },
  hublog: (lvl, msg) => console.log("  [" + lvl + "] " + msg),
  baseDir: BASE,
  assetDir: BASE,
  gcodeFolderFor: () => path.resolve(BASE, cfg.gcodeFolder || "./gcode"),
  provide: () => {},
  use: key => (key === "dispatch.jobs" ? () => D.jobs : undefined)
};

R.register(ctx);

// Minimal express-ish res so we can call the handler directly.
function call(route, query) {
  let out = null, code = 200;
  const res = { json: o => { out = o; return res; }, status: c => { code = c; return res; } };
  routes[route]({ query: query || {}, body: {} }, res);
  return { code, out };
}

const t0 = Date.now();
const { code, out } = call("GET /api/resources", {});
const ms = Date.now() - t0;

if (code !== 200) { console.log("HTTP " + code + " " + JSON.stringify(out)); process.exit(1); }

const money = v => (v == null ? "     —" : ("$" + v.toFixed(2)).padStart(6));
const g = v => (v == null ? "      ?" : (v.toFixed(0) + " g").padStart(7));

console.log("\n  cold rollup in " + ms + " ms   (" + out.cache_entries + " files parsed)");
console.log("  " + out.counted_jobs + " jobs / " + out.counted_units + " units counted, " +
            out.unresolved.length + " unresolved\n");

const H = "  MATERIAL  COLOR      NEEDED   ON HAND    SHORT  ROLLS    COST  SPOOL";
console.log(H);
console.log("  " + "-".repeat(H.length - 2));
for (const r of out.rows) {
  console.log("  " +
    r.material.padEnd(9) +
    r.color_hex.padEnd(9) +
    g(r.needed_g) + "  " + g(r.on_hand_g) + "  " + g(r.shortfall_g) +
    String(r.rolls_to_buy == null ? "  —" : "  " + r.rolls_to_buy).padStart(6) +
    "  " + money(r.est_cost) + "  " +
    (r.spool_name || "(unassigned)") +
    (r.match === "nearest" ? "  [dE " + r.match_de + (r.needs_review ? " REVIEW]" : "]") : "") +
    (r.match === "mapped" ? "  [mapped]" : ""));
}

const T = out.totals;
console.log("\n  TOTALS  " + T.colors + " colours   need " + T.needed_g.toFixed(0) +
            " g   short " + T.shortfall_g.toFixed(0) + " g   " +
            T.rolls_to_buy + " rolls   $" + T.est_cost.toFixed(2));
console.log("          " + T.short_colors + " short, " + T.unknown_on_hand +
            " unknown on-hand, " + T.unassigned + " unassigned, " +
            T.review + " to review, " + T.unpriced_rows + " unpriced");

if (out.unresolved.length) {
  console.log("\n  UNRESOLVED (still counted as a warning, never dropped):");
  for (const u of out.unresolved) console.log("    " + u.file + " x" + u.units + " — " + u.reason);
}

// --- warm-cache timing: proves the (path,mtime,size) key actually hits --------
const t1 = Date.now();
call("GET /api/resources", {});
const warm = Date.now() - t1;
console.log("\n  warm rollup in " + warm + " ms   (" +
            (ms > 0 ? Math.round(ms / Math.max(warm, 1)) : 1) + "x faster)");

// --- invariants ---------------------------------------------------------------
let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL  " + m); fail++; } };

ok(out.rows.length > 0, "no rows produced");
ok(warm < Math.max(ms / 2, 50), "warm rollup not materially faster — cache may not be hitting");
// Shortfall-first ordering.
let seenSettled = false;
for (const r of out.rows) {
  if (r.shortfall_g === 0 && r.on_hand_g != null) seenSettled = true;
  else if (r.shortfall_g > 0) ok(!seenSettled, "shortfall row sorted below a settled row");
}
// Never invent a price, never invent inventory.
for (const r of out.rows) {
  if (r.cost_per_roll == null) ok(r.est_cost == null, r.color_hex + ": cost with no cost_per_roll");
  if (!r.on_hand_known && !out.settings.assume_empty_when_unset)
    ok(r.on_hand_g == null && r.shortfall_g == null,
       r.color_hex + ": shortfall computed against unknown inventory");
  if (r.rolls_to_buy > 0) ok(r.shortfall_g > 0, r.color_hex + ": rolls to buy with no shortfall");
}
ok(T.est_cost === +out.rows.reduce((a, r) => a + (r.est_cost || 0), 0).toFixed(2),
   "totals.est_cost does not match the rows");

console.log(fail ? "\n  " + fail + " invariant(s) FAILED" : "\n  all invariants passed");
process.exit(fail ? 1 : 0);
