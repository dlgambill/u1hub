// scripts/gate-timelapse.js — live hardware gate for modules/timelapse.js.
//
//   node scripts/gate-timelapse.js <printer-ip>
//
// Rule #2 (CLAUDE.md): built is not shippable until its live hardware gate
// has passed. This checks the two things that can only be checked against a
// REAL printer:
//   1. the built-in camera folder is reachable and lists real .mp4 renders
//   2. pickCameraFile(), fed that real listing plus a synthetic "just
//      finished" event built from the printer's own most recent completed
//      job (via Moonraker history), lands on a plausible match
//
// Deliberately does NOT call the SF3D upload endpoint - that would write a
// real row into production sf3d_timelapses and a real object into
// production R2 from test data. The upload path itself is exercised for
// real the first time an actual print completes with sf3dTimelapse.passcode
// set in config.json; watch the Hub's log for "timelapse: uploaded" or
// "timelapse: ..." warnings when that happens, and record the result here.
"use strict";

const { pickCameraFile } = require("../modules/timelapse.js");

const IP = process.argv[2];
if (!IP) { console.error("usage: node scripts/gate-timelapse.js <printer-ip>"); process.exit(2); }
const BASE = "http://" + IP;

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra).slice(0, 400))); }
};

(async () => {
  console.log("\n== " + BASE + "/server/info");
  let info;
  try { info = await (await fetch(BASE + "/server/info")).json(); }
  catch (e) { ok(false, "printer reachable", String(e)); console.log("\n" + pass + " passed, " + fail + " failed\n"); process.exitCode = 1; return; }
  ok(info && info.result && info.result.klippy_connected, "klippy connected", info && info.result);

  console.log("\n== " + BASE + "/server/files/list?root=camera");
  const listRes = await (await fetch(BASE + "/server/files/list?root=camera")).json().catch(() => null);
  const files = (listRes && listRes.result) || [];
  ok(files.length > 0, "camera folder lists at least one rendered file", { count: files.length });
  const mp4s = files.filter((f) => /\.mp4$/i.test(f.path));
  ok(mp4s.length > 0, "at least one is an .mp4 (not just thumbnails)", { count: mp4s.length });
  for (const f of mp4s.slice(0, 5)) console.log("    " + f.path + "  (" + f.size + " bytes, modified " + new Date(f.modified * 1000).toISOString() + ")");

  console.log("\n== " + BASE + "/server/history/list?limit=1&order=desc");
  const hist = await (await fetch(BASE + "/server/history/list?limit=1&order=desc")).json().catch(() => null);
  const job = hist && hist.result && hist.result.jobs && hist.result.jobs[0];
  ok(!!job, "at least one job in history", job && { filename: job.filename, status: job.status });

  if (job && job.status === "completed" && mp4s.length) {
    // Synthesize the event modules/timelapse.js would have gotten for this
    // job right after it finished, and confirm pickCameraFile lands on
    // something plausible from the REAL listing above.
    const eventAt = job.end_time * 1000;
    const startAt = job.start_time * 1000;
    const match = pickCameraFile(mp4s, eventAt, startAt);
    ok(!!match, "pickCameraFile finds a candidate for the most recent completed job",
      { job: job.filename, window_start: new Date(startAt).toISOString(), window_end: new Date(eventAt + 5 * 60 * 1000).toISOString() });
    if (match) console.log("    would fetch: " + match.path);
  } else {
    console.log("\n  (most recent job isn't 'completed', or no .mp4s exist yet - skipping the match check)");
  }

  console.log("\n" + pass + " passed, " + fail + " failed\n");
  // process.exitCode, not process.exit(): an immediate exit() while
  // fetch's keep-alive sockets are still winding down crashes Node on
  // Windows (a real libuv assertion, hardware-verified 2026-09-21 running
  // this very script against .175 - "4 passed, 0 failed" printed, then
  // "Assertion failed... UV_HANDLE_CLOSING" and a nonzero exit anyway,
  // which would have told any caller checking the exit code that a
  // passing gate had failed). Setting exitCode and letting the event loop
  // drain naturally avoids the race entirely.
  process.exitCode = fail ? 1 : 0;
})();
