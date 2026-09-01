// test/amounts-standalone.js — parser.js filament-amount extraction, run against
// REAL sliced gcode in the bound library (not fixtures). Standalone on purpose:
// same pattern as slicing-standalone.js, so it can be pointed at any file while
// characterising a new slicer.
//   node test/amounts-standalone.js ["Cats (Long Gray).gcode"] ...
"use strict";
const fs = require("fs");
const path = require("path");
const { parseGcodeMap } = require("../parser.js");

const HEAD = 64 * 1024;
const TAIL = 512 * 1024;

// Head + tail only. The config block lives at the end; the header block (the
// only colon-form density/diameter) lives at the start. Never stream the body.
function readEnds(fp) {
  const st = fs.statSync(fp);
  if (st.size <= HEAD + TAIL) return { text: fs.readFileSync(fp, "utf8"), st, whole: true };
  const fd = fs.openSync(fp, "r");
  try {
    const h = Buffer.alloc(HEAD);
    fs.readSync(fd, h, 0, HEAD, 0);
    const t = Buffer.alloc(TAIL);
    fs.readSync(fd, t, 0, TAIL, st.size - TAIL);
    return { text: h.toString("utf8") + "\n" + t.toString("utf8"), st, whole: false };
  } finally { fs.closeSync(fd); }
}

const cfgPath = path.join(__dirname, "..", "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const dir = path.resolve(path.join(__dirname, ".."), cfg.gcodeFolder || "./gcode");

let names = process.argv.slice(2);
if (!names.length) {
  names = fs.readdirSync(dir).filter(f => /\.gcode$/i.test(f)).slice(0, 5);
}

let fail = 0, pass = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL  " + msg); } };

for (const name of names) {
  const fp = path.join(dir, name);
  if (!fs.existsSync(fp)) { console.log("MISSING " + name); fail++; continue; }
  const t0 = Date.now();
  const { text, st, whole } = readEnds(fp);
  const r = parseGcodeMap(text, { scanBody: false });
  const a = r.amounts;
  const ms = Date.now() - t0;

  console.log("\n=== " + name + " ===");
  console.log("  size " + (st.size / 1048576).toFixed(1) + " MB  read " +
              (whole ? "whole" : "head+tail") + "  " + ms + " ms");
  console.log("  est time      : " + r.estTime);
  console.log("  slots         : " + a.slots.length + "   used: [" + r.usedIdx.join(", ") + "]");
  for (const s of a.slots) {
    const hex = (r.palette[s.i] || {}).hex || "(none)";
    console.log("    [" + s.i + "] " + String(hex).padEnd(8) +
      " " + String((s.grams == null ? "-" : s.grams.toFixed(2)) + " g").padStart(10) +
      "  " + String((s.length_mm == null ? "-" : s.length_mm.toFixed(1)) + " mm").padStart(12) +
      "  " + (s.volume_cm3 == null ? "-" : s.volume_cm3.toFixed(2) + " cm3").padStart(11) +
      "  $" + (s.slicer_cost == null ? "-" : s.slicer_cost.toFixed(2)) +
      (s.grams_derived ? "  (derived from mm)" : ""));
  }
  console.log("  slot sum      : " + a.slot_sum_g + " g");
  console.log("  total [g]     : " + a.total_g + " g");
  console.log("  unaccounted   : " + a.unaccounted_g + " g   suspect=" + a.suspect_unaccounted);
  console.log("  tool changes  : " + a.tool_changes);

  // --- invariants -----------------------------------------------------------
  ok(a.have_grams, name + ": no per-slot grams found");
  ok(a.total_g != null, name + ": no 'total filament used [g]'");
  ok(!a.suspect_unaccounted,
     name + ": slot sum " + a.slot_sum_g + " g vs total " + a.total_g +
     " g differs by " + a.unaccounted_g + " g — purge model may not hold here");
  // Every slot the palette calls "used" must carry grams > 0, and vice versa.
  for (const s of a.slots) {
    const used = (r.palette[s.i] || {}).used;
    if (used) ok(s.grams > 0, name + ": slot " + s.i + " marked used but grams=" + s.grams);
    else ok(!(s.grams > 0), name + ": slot " + s.i + " not used but grams=" + s.grams);
  }
  // Density cross-check: cm3 * density should reproduce grams within 1%.
  for (const s of a.slots) {
    if (s.volume_cm3 > 0 && s.density > 0 && s.grams > 0) {
      const calc = s.volume_cm3 * s.density;
      ok(Math.abs(calc - s.grams) / s.grams < 0.01,
         name + ": slot " + s.i + " cm3*density=" + calc.toFixed(2) + " vs g=" + s.grams);
    }
  }
  // mm -> g formula must agree with what the slicer reported.
  for (const s of a.slots) {
    if (s.length_mm > 0 && s.diameter_mm > 0 && s.density > 0 && s.grams > 0) {
      const r2 = s.diameter_mm / 2;
      const calc = Math.PI * r2 * r2 * s.length_mm * s.density / 1000;
      ok(Math.abs(calc - s.grams) / s.grams < 0.02,
         name + ": slot " + s.i + " mm-formula=" + calc.toFixed(2) + " vs g=" + s.grams);
    }
  }
  // Colour / type lists must stay index-aligned with the amount slots.
  ok(r.palette.length >= a.slots.length,
     name + ": palette " + r.palette.length + " shorter than amount slots " + a.slots.length);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
