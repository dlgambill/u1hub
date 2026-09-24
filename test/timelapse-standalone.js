// test/timelapse-standalone.js — pure logic in modules/timelapse.js.
//
// Kept out of run-tests.js because it needs no Hub, no mock printer and no
// network: slugify/buildR2Key/fmtPrintedAt/frameFileName/assembleArgs are
// pure functions.
//
//   node test/timelapse-standalone.js
//
// The table below is not invented - every (gcode_filename, r2_key) pair came
// straight out of sf3d_timelapses (project pcbltjgwnuyaixiealbk), pulled
// 2026-09-21 while reverse-engineering the naming convention for the U1
// rebuild. If slugify ever stops matching these, new uploads land at a
// r2_key the storefront's existing 169 videos don't use, silently.

"use strict";
const { slugify, buildR2Key, fmtPrintedAt, scaleFitFilter, stillSegmentFilter, mainSegmentFilter, mainEncodeArgs, stillEncodeArgs, frameFileName, assembleArgs } = require("../modules/timelapse.js");

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

// ---- frameFileName / assembleArgs (2026-09-24 capture rewrite) ----
// Replaces the old pickCameraFile tests - that function (and the whole
// "wait for firmware to render a file, then fetch it" design it served) is
// gone. See modules/timelapse.js's header comment for why: a fleet check
// found only 2 of 9 printers had ever produced a rendered file, and the
// newest of those was from January - months before this module shipped.
{
  ok(frameFileName(1) === "frame_000001.jpg", "frameFileName pads to 6 digits", { got: frameFileName(1) });
  ok(frameFileName(42) === "frame_000042.jpg", "frameFileName pads a 2-digit number to 6", { got: frameFileName(42) });
  ok(frameFileName(123456) === "frame_123456.jpg", "frameFileName doesn't truncate a 6-digit number", { got: frameFileName(123456) });
}
{
  const args = assembleArgs("/tmp/frames", "/tmp/out.mp4", 12);
  ok(!args.includes("-r"), "assembleArgs never passes a standalone output -r flag", { args });
  ok(args.includes("-framerate") && args[args.indexOf("-framerate") + 1] === "12",
    "assembleArgs sets -framerate from its fps argument", { args });
  ok(args.includes("/tmp/frames/frame_%06d.jpg"), "assembleArgs points -i at the frame glob inside framesDir", { args });
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

// ---- mainEncodeArgs / stillEncodeArgs: exactly one frame-rate mechanism ----
// (2026-09-24 regression) The first shipped compose pipeline passed a
// standalone "-r 30" ffmpeg flag ALONGSIDE the filter graph's own "fps=30"
// clause - two separate frame-rate conversions stacked on the same stream.
// Invisible on the still image loops (Danny's demo outro looked fine), but
// it visibly scrambled the real timelapse into what Danny described as "a
// demigorgan" - caught by him actually watching the output, not by these
// tests, which only ever checked filter STRINGS, never the full argv ffmpeg
// actually runs. Pin the real argv here so that gap can't reopen silently.
{
  const args = mainEncodeArgs("in.mp4", "out.mp4", 1920, 1080);
  ok(!args.includes("-r"), "mainEncodeArgs never passes a standalone -r flag", { args });
  ok(args.includes(mainSegmentFilter(1920, 1080)), "mainEncodeArgs' -vf is exactly mainSegmentFilter's output", { args });
}
{
  const { args, duration } = stillEncodeArgs("logo.png", "out.mp4", 1920, 1080, 1.5, 0.5, "both");
  ok(!args.includes("-r"), "stillEncodeArgs never passes a standalone -r flag", { args });
  const want = stillSegmentFilter(1920, 1080, 1.5, 0.5, "both");
  ok(args.includes(want.filter) && duration === want.duration,
    "stillEncodeArgs' -vf and duration match stillSegmentFilter exactly", { args, duration });
}

// Falsification (rule #6): prove the check above would actually have
// CAUGHT the real 2026-09-24 bug, not just that today's code happens to
// pass it. Reproduce the old (buggy) argv shape inline and confirm the
// same assertion fails against it.
{
  const buggyArgs = ["-y", "-i", "in.mp4", "-vf", mainSegmentFilter(1920, 1080),
    "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", "out.mp4"];
  ok(buggyArgs.includes("-r"), "the old buggy argv shape (with -r) is exactly what this test would flag", { buggyArgs });
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
