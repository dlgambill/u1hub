// test/timelapse-standalone.js — pure logic in modules/timelapse.js.
//
// Kept out of run-tests.js because it needs no Hub, no mock printer and no
// network: slugify/buildR2Key/fmtPrintedAt/pickCameraFile are pure functions.
//
//   node test/timelapse-standalone.js
//
// The table below is not invented - every (gcode_filename, r2_key) pair came
// straight out of sf3d_timelapses (project pcbltjgwnuyaixiealbk), pulled
// 2026-09-21 while reverse-engineering the naming convention for the U1
// rebuild. If slugify ever stops matching these, new uploads land at a
// r2_key the storefront's existing 169 videos don't use, silently.

"use strict";
const { slugify, buildR2Key, fmtPrintedAt, pickCameraFile, escapeDrawtext, ctaFilter } = require("../modules/timelapse.js");

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail))); }
};

// [gcode_filename, expected slug] - real rows from sf3d_timelapses.
const SLUG_TABLE = [
  ["Pit Viper (Female Dark Waglers).gcode", "Pit-Viper--Female-Dark-Waglers"],
  ["Tail_PLA_2h5m.gcode", "Tail_PLA_2h5m"],
  ["Bearded Dragon (Red Monster) x3.gcode", "Bearded-Dragon--Red-Monster--x3"],
  ["Gizmo (Small).gcode", "Gizmo--Small"],
  ["bottom (1)_PLA_4h55m.gcode", "bottom--1-_PLA_4h55m"],
  ["Crystal Dragons (Small).gcode", "Crystal-Dragons--Small"],
  ["SeaTurtle_PLA_22h22m.gcode", "SeaTurtle_PLA_22h22m"],
];
for (const [input, want] of SLUG_TABLE) {
  const got = slugify(input);
  ok(got === want, "slugify(" + JSON.stringify(input) + ")", { want, got });
}

// Falsification (rule #6): the double-hyphen behavior above ("bottom (1)"
// -> "bottom--1-", two adjacent non-alnum chars each becoming their own
// hyphen) is the whole reason a naive "collapse runs of non-alnum into ONE
// hyphen" implementation would land at the WRONG key. Prove it actually
// differs, so the table above is load-bearing and not just restating itself.
{
  const naiveSlug = (s) => String(s).replace(/\.gcode$/i, "").replace(/[^A-Za-z0-9_]+/g, "-").replace(/^-+|-+$/g, "");
  const disagreements = SLUG_TABLE.filter(([input, want]) => naiveSlug(input) !== want);
  ok(disagreements.length > 0,
    "a run-collapsing slugify demonstrably disagrees with real production keys",
    { disagreements: disagreements.map(([i]) => i) });
}

// Full r2_key, end to end - real row: printer U5, printed 2026-07-26T04:23:35Z.
{
  const key = buildR2Key("U5", "Bearded Dragon (Red Monster) x3.gcode", "20260726T042335Z");
  ok(key === "timelapses/Bearded-Dragon--Red-Monster--x3/U5_20260726T042335Z_Bearded-Dragon--Red-Monster--x3.mp4",
    "buildR2Key reproduces a real production r2_key exactly", { key });
}

// fmtPrintedAt - a known UTC instant, not the local clock (rule 7: no
// wall-clock dependence). 2026-07-26T04:23:35.000Z in epoch ms:
{
  const ms = Date.UTC(2026, 6, 26, 4, 23, 35); // month is 0-based: 6 = July
  ok(fmtPrintedAt(ms) === "20260726T042335Z", "fmtPrintedAt formats a known UTC instant", { got: fmtPrintedAt(ms) });
}

// pickCameraFile - excludes a stale leftover, excludes a too-early file,
// picks the newest in-window candidate when more than one exists.
{
  const eventAt = Date.UTC(2026, 8, 21, 12, 0, 0);
  const startAt = eventAt - 20 * 60 * 1000; // print "started" 20 min earlier
  const files = [
    { path: "Old_Job_PLA_1h0m_20260101T000000Z.mp4", modified: Date.UTC(2026, 0, 1) / 1000 }, // weeks-old leftover
    { path: "Old_Job_PLA_1h0m_20260101T000000Z.jpg", modified: Date.UTC(2026, 0, 1) / 1000 }, // not .mp4, ignored either way
    { path: "TooEarly_PLA_20260921T113000Z.mp4", modified: (startAt - 5 * 60 * 1000) / 1000 }, // before print started
    { path: "ThisPrint_PLA_20260921T121000Z.mp4", modified: (eventAt + 60 * 1000) / 1000 }, // 1 min after completion - the real one
  ];
  const match = pickCameraFile(files, eventAt, startAt);
  ok(!!match && match.path === "ThisPrint_PLA_20260921T121000Z.mp4",
    "pickCameraFile excludes stale and too-early files, picks the real render", { match });

  ok(pickCameraFile([], eventAt, startAt) === null, "pickCameraFile returns null with no candidates");
}

// ---- escapeDrawtext / ctaFilter (2026-09-23, TikTok CTA overlay) ----
{
  ok(escapeDrawtext("Order now: TikTok Shop") === "Order now\\: TikTok Shop",
    "escapeDrawtext escapes a literal colon");
  ok(escapeDrawtext("Danny's Shop") === "Danny’s Shop",
    "escapeDrawtext swaps a straight apostrophe for a curly one");
  ok(escapeDrawtext("a\\b") === "a\\\\b",
    "escapeDrawtext doubles a literal backslash");
  ok(escapeDrawtext("50% off") === "50\\% off",
    "escapeDrawtext escapes a literal percent sign");
}

// Falsification (rule #6): an unescaped colon in the CTA text adds an extra
// top-level ':' to the filter string, indistinguishable to ffmpeg's parser
// from the ':' that separates drawtext's own fontfile/text/fontcolor/...
// options - it has no way to tell "a colon inside my text" from "the next
// option starts here". Prove escaping actually removes that ambiguity by
// counting unescaped colons in a naive (unescaped) filter string against the
// real, escaped one.
{
  const raw = "Order now: TikTok Shop";
  const countUnescapedColons = (s) => (s.match(/(^|[^\\]):/g) || []).length;
  const naiveFilter = "drawtext=fontfile='X':text='" + raw + "':fontcolor=white";
  const realFilter = "drawtext=fontfile='X':text='" + escapeDrawtext(raw) + "':fontcolor=white";
  ok(countUnescapedColons(naiveFilter) > countUnescapedColons(realFilter),
    "escaping removes the extra unescaped colon a naive filter string would carry into drawtext's option parser",
    { naive: countUnescapedColons(naiveFilter), real: countUnescapedColons(realFilter) });
}

// ctaFilter - exact reproduction, including the fixed font path this module
// actually ships. Pins CTA_FONT_FILE from drifting silently, since it isn't
// itself exported.
{
  const filt = ctaFilter("Shop link in bio");
  const want = "drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='Shop link in bio':" +
    "fontcolor=white:fontsize=h/16:box=1:boxcolor=black@0.55:boxborderw=16:x=(w-text_w)/2:y=h*0.80";
  ok(filt === want, "ctaFilter builds the exact drawtext filter string", { filt });
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
