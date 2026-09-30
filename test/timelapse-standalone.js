// test/timelapse-standalone.js — pure logic in modules/timelapse.js.
//
// Kept out of run-tests.js because it needs no Hub, no mock printer and no
// network: slugify/buildR2Key/fmtPrintedAt/frameFileName/assembleArgs are
// pure functions.
//
//   node test/timelapse-standalone.js
//
// The table below is not invented - every (gcode_filename, r2_key) pair came
// straight out of the storefront's timelapse table, pulled
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

// [gcode_filename, expected slug] - real rows from that table.
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
  ok(args.includes(require("path").join("/tmp/frames", "frame_%06d.jpg")), "assembleArgs points -i at the frame glob inside framesDir (on Windows too)", { args });
}

// ---- scaleFitFilter / stillSegmentFilter / mainSegmentFilter ----
// (2026-09-23, logo-intro + product-photo-outro compositing, replacing the
// burned-in "Shop link in bio" CTA the owner rejected: "Get rid of it.")

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
// Invisible on the still image loops (the demo outro looked fine), but
// it visibly scrambled the real timelapse into what was described as "a
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

// ---- 2026-09-30: stale frames ------------------------------------------------
// A real video (Possum x2) held ~20 different pictures in 343 frames: the
// printer stops its camera monitor 6 minutes after the last start_monitor,
// and every grab after that saved the same old monitor.jpg.
{
  const { frameFreshness, parseYavg, keepFrames, FRESH_MAX_AGE_MS, DARK_YAVG } = require("../modules/timelapse.js");
  const T = "Wed, 30 Sep 2026 01:08:07 GMT", T1 = "Wed, 30 Sep 2026 01:08:08 GMT", OLD = "Tue, 29 Sep 2026 23:24:59 GMT";
  const f1 = frameFreshness(T, T, 0);
  ok(f1.known && f1.fresh && f1.age === 0, "a frame written this second is fresh", f1);
  ok(frameFreshness(T, T1, 0).fresh, "…and still fresh a second later (HTTP dates are whole seconds)");
  const stale = frameFreshness(OLD, T, 0);
  ok(stale.known && !stale.fresh && stale.age > FRESH_MAX_AGE_MS, "a monitor.jpg 1.5 hours old (what production showed) is stale", stale);
  ok(!frameFreshness(T, T, Date.parse(T)).fresh, "the same picture as the last saved frame is not fresh, however recent");
  ok(frameFreshness(T1, T1, Date.parse(T)).fresh, "a newer picture than the last saved frame is fresh");
  // Judged by the printer's own clock: a Hub PC hours off does not matter,
  // because only Last-Modified vs the printer's Date header is compared.
  ok(frameFreshness("Wed, 30 Sep 2026 09:00:00 GMT", "Wed, 30 Sep 2026 09:00:01 GMT", 0).fresh, "freshness never reads the Hub's own clock");
  const nk = frameFreshness(null, T, 0);
  ok(nk.known === false && nk.fresh === false, "no Last-Modified: unknown (caller compares bytes instead)", nk);

  const txt = "[Parsed_metadata_2 @ 0x1] frame:0    pts:0\n[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YAVG=87.25\n" +
    "[Parsed_metadata_2 @ 0x1] frame:1    pts:1\n[Parsed_metadata_2 @ 0x1] lavfi.signalstats.YAVG=0.047\n";
  const y = parseYavg(txt);
  ok(y.length === 2 && y[0] === 87.25 && y[1] === 0.047, "parseYavg reads ffmpeg's per-frame brightness in order", y);
  ok(parseYavg("").length === 0 && parseYavg(null).length === 0, "parseYavg of nothing is an empty list");

  // frames: 0 ok, 1 repeat of 0, 2 dark, 3 new, 4 repeat of 3, 5 new (same bytes as 0 but not adjacent to a kept 0)
  const k = keepFrames([80, 80, 3, 90, 90, 80], ["a", "a", "b", "c", "c", "a"], DARK_YAVG);
  ok(JSON.stringify(k) === "[0,3,5]", "keepFrames drops dark frames and back-to-back repeats, keeps order", k);
  ok(JSON.stringify(keepFrames([], ["a", "b"], DARK_YAVG)) === "[0,1]", "no brightness readings: judge by repeats only (fail open)");
  ok(keepFrames(new Array(261).fill(0.05), Array.from({ length: 261 }, (_, i) => "h" + i), DARK_YAVG).length === 0,
    "the all-black overnight video (vaporeon x8, YAVG ~0.05) keeps nothing");
}

// camera.js's live view must renew the monitor: the U1 firmware stops it
// 360 s after the last camera.start_monitor (printer unisrv.log,
// 2026-09-30), and a socket that only started it on open froze on its last
// picture. Driven for real: the module is registered against a fake ctx and a
// fake WebSocket, the printer's "monitoring: false" is delivered, and the
// clock is moved. CAMERA_JS lets rule 6 point this at the pre-fix file.
async function liveViewCheck() {
  const camPath = process.env.CAMERA_JS ? require("path").resolve(process.env.CAMERA_JS) : require.resolve("../modules/camera.js");
  delete require.cache[camPath];
  const sent = [];
  let sock = null;
  class FakeWS {
    constructor() { sock = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(m) { sent.push(JSON.parse(m).method); }
    close() { this.readyState = 3; }
  }
  const realWS = global.WebSocket, realSI = global.setInterval, realFetch = global.fetch, realNow = Date.now;
  let offset = 0;
  global.WebSocket = FakeWS;
  global.setInterval = () => ({ unref() {} });
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer });
  Date.now = () => realNow() + offset;
  let handler = null;
  const ctx = { printers: [{ name: "U1", url: "http://printer" }], app: { get: (route, fn) => { if (route === "/api/camera") handler = fn; } }, hublog() {} };
  const res = { status() { return this; }, json() { return this; }, end() { return this; }, set() { return this; }, type() { return this; }, send() { return this; } };
  const starts = () => sent.filter((m) => m === "camera.start_monitor").length;
  try {
    require(camPath).register(ctx);
    await handler({ query: { id: "0" } }, res);
    await new Promise((r) => setTimeout(r, 5));
    const first = starts();
    offset += 6000; // past the reconnect cooldown
    sock.onmessage({ data: JSON.stringify({ method: "notify_camera_status_change", params: [{ monitor_domain: "lan", monitoring: false }] }) });
    await handler({ query: { id: "0" } }, res);
    const afterStop = starts();
    offset += 5 * 60 * 1000; // still watching, five minutes on
    await handler({ query: { id: "0" } }, res);
    return { first, afterStop, afterKeepalive: starts() };
  } finally {
    global.WebSocket = realWS; global.setInterval = realSI; global.fetch = realFetch; Date.now = realNow;
  }
}

(async () => {
  const v = await liveViewCheck();
  ok(v.first >= 1, "a live view starts the monitor", v);
  ok(v.afterStop === v.first + 1, "when the printer reports the monitor stopped, the next view request starts it again", v);
  ok(v.afterKeepalive === v.afterStop + 1, "a view still open after 5 minutes renews it before the firmware's 6-minute cutoff", v);

  console.log("\n" + pass + " passed, " + fail + " failed\n");
  process.exit(fail ? 1 : 0);
})();
