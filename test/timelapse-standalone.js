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
const { slugify, buildR2Key, fmtPrintedAt, pickCameraFile, scaleFitFilter, stillSegmentFilter, mainSegmentFilter } = require("../modules/timelapse.js");

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

// ---- scaleFitFilter / stillSegmentFilter / mainSegmentFilter ----
// (2026-09-23, logo-intro + product-photo-outro compositing, replacing the
// burned-in "Shop link in bio" CTA Danny rejected: "Get rid of it.")

// scaleFitFilter - exact reproduction, including the fixed COMPOSE_FPS=30
// this module actually ships. Pins that constant from drifting silently,
// since it isn't itself exported.
{
  const filt = scaleFitFilter(1920, 1080);
  const want = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:" +
    "(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p";
  ok(filt === want, "scaleFitFilter builds the exact scale/pad/fps filter string", { filt });
}

// mainSegmentFilter is scaleFitFilter with no fade - the timelapse is
// already the held middle of the composited video.
{
  ok(mainSegmentFilter(1280, 720) === scaleFitFilter(1280, 720),
    "mainSegmentFilter adds no fade beyond scaleFitFilter");
}

// stillSegmentFilter - duration math for each fade-edge mode, and that the
// fade clauses actually land in the filter string, not just the duration.
{
  const none = stillSegmentFilter(1920, 1080, 3, 0.5, "none");
  ok(none.duration === 3 && none.filter === scaleFitFilter(1920, 1080),
    "stillSegmentFilter('none') adds no fade time or fade clause", none);

  const inOnly = stillSegmentFilter(1920, 1080, 3, 0.5, "in");
  ok(inOnly.duration === 3.5 && inOnly.filter === scaleFitFilter(1920, 1080) + ",fade=t=in:st=0:d=0.5",
    "stillSegmentFilter('in') adds fadeSec once and a fade-in clause at st=0", inOnly);

  const outOnly = stillSegmentFilter(1920, 1080, 3, 0.5, "out");
  ok(outOnly.duration === 3.5 && outOnly.filter === scaleFitFilter(1920, 1080) + ",fade=t=out:st=3:d=0.5",
    "stillSegmentFilter('out') adds fadeSec once and a fade-out clause starting at the hold's end", outOnly);

  const both = stillSegmentFilter(1920, 1080, 1.5, 0.5, "both");
  ok(both.duration === 2.5 &&
     both.filter === scaleFitFilter(1920, 1080) + ",fade=t=in:st=0:d=0.5,fade=t=out:st=2:d=0.5",
    "stillSegmentFilter('both') adds fadeSec twice and both clauses, fade-out starting at duration-fadeSec", both);
}

// Falsification (rule #6): if the fade-out start time were computed from
// holdSec alone instead of (holdSec + fadeSec), a fade-in-and-out clip would
// fade out too early - partway through its own fade-in, clipping the hold
// short. With fadeSec=1, holdSec=2, edges=both: duration=4, correct
// fade-out start=3; a holdSec-only calculation would wrongly say 2. Prove
// the real one, not the wrong one, shows up in the filter string.
{
  const both = stillSegmentFilter(10, 10, 2, 1, "both");
  ok(both.filter.includes("fade=t=out:st=3:d=1") && !both.filter.includes("fade=t=out:st=2:d=1"),
    "fade-out start time is duration-fadeSec, not holdSec alone - it accounts for the fade-in time already spent",
    { filter: both.filter });
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
