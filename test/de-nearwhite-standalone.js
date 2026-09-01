// test/de-nearwhite-standalone.js — how well does dE2000 separate the near-white
// family (white / bone / cream / flesh)? These are the colours where a matcher
// is most likely to be confidently wrong, and where CIEDE2000's lightness term
// compresses distances. Uses the REAL hexes appearing in the scheduled library.
"use strict";
const R = require("../modules/resources.js");
const lab = h => R.rgbToLab(R.hexToRgb(h));
const de = (a, b) => R.deltaE2000(lab(a), lab(b));

const SET = [
  ["#FFFFFF", "pure white (slicer slot)"],
  ["#FFFFCC", "warm white"],
  ["#FFECB3", "cream"],
  ["#F8E1C2", "bone / light tan"],
  ["#F4E2C1", "bone (PETG)"],
  ["#E8DBB7", "bone / khaki"],
  ["#DDCFB5", "darker bone"],
  ["#EAC9B0", "flesh / light"],
  ["#FFD6C1", "flesh / pink"],
  ["#CBC6B8", "warm grey"],
  ["#BEBBBF", "Elegoo Clear (real spool)"]
];

const W = 9;
process.stdout.write("".padEnd(26));
for (const [h] of SET) process.stdout.write(h.slice(1, 4).padStart(W));
console.log();
for (const [h1, n1] of SET) {
  process.stdout.write((h1 + " " + n1).slice(0, 25).padEnd(26));
  for (const [h2] of SET) {
    const d = de(h1, h2);
    process.stdout.write((h1 === h2 ? "-" : d.toFixed(1)).padStart(W));
  }
  console.log();
}

console.log("\nNeighbour pairs most at risk of being conflated:");
const pairs = [];
for (let i = 0; i < SET.length; i++)
  for (let j = i + 1; j < SET.length; j++)
    pairs.push([SET[i], SET[j], de(SET[i][0], SET[j][0])]);
pairs.sort((a, b) => a[2] - b[2]);
for (const [a, b, d] of pairs.slice(0, 8))
  console.log("  dE " + d.toFixed(1).padStart(5) + "   " +
              a[0] + " " + a[1] + "  vs  " + b[0] + " " + b[1]);

console.log("\nLightness/chroma detail (L*, a*, b*):");
for (const [h, n] of SET) {
  const [L, a, b] = lab(h);
  console.log("  " + h + "  L " + L.toFixed(1).padStart(5) +
              "   a " + a.toFixed(1).padStart(5) +
              "   b " + b.toFixed(1).padStart(5) + "   " + n);
}

// --- regression gate ----------------------------------------------------------
// These are the separations the ceiling was chosen to guarantee. If a future
// change to the colour maths or the ceiling breaks one of them, this goes red.
const CEILING = 7;
let fail = 0;
const ok = (c, m) => { if (!c) { console.log("  FAIL  " + m); fail++; } };

const WHITE = "#FFFFFF";
const BONES = ["#F8E1C2", "#F4E2C1", "#E8DBB7", "#DDCFB5"];
const FLESH = ["#EAC9B0", "#FFD6C1"];

console.log("\nRegression gate (ceiling " + CEILING + "):");
for (const b of BONES)
  ok(de(WHITE, b) > CEILING, "white would match bone " + b + " (dE " + de(WHITE, b).toFixed(1) + ")");
for (const f of FLESH)
  ok(de(WHITE, f) > CEILING, "white would match flesh " + f + " (dE " + de(WHITE, f).toFixed(1) + ")");
for (const b of BONES)
  for (const f of FLESH)
    ok(de(b, f) > CEILING, "bone " + b + " would match flesh " + f + " (dE " + de(b, f).toFixed(1) + ")");

// The matches the ceiling must NOT throw away — verified by eye against the
// real shelf on 2026-08-31.
const KEEP = [["#37383B", [25.71, -0.26, 0.22], "Bambu Black"],
              ["#C0C0C0", null, "Elegoo Clear"],
              ["#80FFFF", null, "Translucent Cyan"]];
const SHELF = { "#C0C0C0": "#BEBBBF", "#80FFFF": "#00FFFF" };
for (const [hex, measured, name] of KEEP) {
  const other = measured || lab(SHELF[hex]);
  const d = R.deltaE2000(lab(hex), other);
  ok(d <= CEILING, hex + " -> " + name + " lost at ceiling " + CEILING + " (dE " + d.toFixed(1) + ")");
}

console.log(fail ? "  " + fail + " FAILED" : "  all separations hold");
process.exit(fail ? 1 : 0);
