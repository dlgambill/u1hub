// test/sprint4-checks.js - Sprint 4 (2.45.0) checks, run by run-tests.js and
// runnable alone: `node test/sprint4-checks.js`.
//
// H10 one fleet snapshot loop; records, events and dispatch subscribe to it.
//
// Client-side behavior is checked at the source level (the harness has no
// DOM); server-side pieces that need no running Hub are called directly.
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(REPO, p), "utf8");

module.exports = async function sprint4Checks(ok) {
  // ---- H10 ----
  const fleet = read("core/fleet.js"), records = read("core/records.js"), events = read("core/events.js"), dispatch = read("modules/dispatch.js");
  const loops = (fleet.match(/setInterval\(\(\) => \{ fleetTick\(\)/g) || []).length;
  ok(loops === 1 && /hub\.events\.listeners\("fleet:tick"\)/.test(fleet), "H10: core/fleet.js runs exactly one scheduled snapshot loop and emits fleet:tick from it", loops);
  ok(!/setInterval\(pollPrintStarts/.test(records) && !/async function probeState/.test(records) && /hub\.events\.on\("fleet:tick"/.test(records),
    "H10: the print-start watcher has no poller and no probes of its own - it reads the loop's snapshot");
  ok(!/setInterval\(\(\) => \{ check\(\)/.test(events) && /events\.on\("fleet:tick"/.test(events) && !/new EventEmitter\(\)/.test(events),
    "H10: fleet events run their edge detection on fleet:tick and share the hub's bus");
  ok(!/setInterval\(\(\) => \{\s*tick\(\)/.test(dispatch) && /ctx\.events\.on\("fleet:tick"/.test(dispatch) && /NEXT_EXEC = now \+ EXEC_TICK_MS - EXEC_SLACK_MS/.test(dispatch),
    "H10: the dispatch executor acts on the loop's snapshot every ~10 s instead of taking its own");
  ok(/events: new \(require\("events"\)\)\(\)/.test(read("server.js")), "H10: the event bus is created with the hub so core files loaded before the fleet can subscribe");
  const rec = fleet.slice(fleet.indexOf("RECONCILE_TIMEOUT_MS = "), fleet.indexOf("}, 20000);"));
  ok(/ctrl\.abort\(\), RECONCILE_TIMEOUT_MS/.test(rec) && /print_task_config", \{ signal: ctrl\.signal \}/.test(rec),
    "H10: the 20 s color reconcile fetch carries an AbortController, so a printer that stops answering cannot hold it open");

  // ---- H18 ----
  // S5 (2.44) marks the copy starting_on at the real start command and plan()
  // counts it in flight for 5 min; the clear-bed route itself only arms the
  // next start. What 2.44.1 left open was the running list's attribution
  // between the printer reporting the print and the executor claiming it.
  ok(/const starting = job\.printing_on == null && job\.starting_on && \(now - \(job\.starting_on\.at \|\| 0\) < STARTING_TTL_MS\)/.test(dispatch)
     && /job\.starting_on = \{ printer: idx, at: Date\.now\(\) \}/.test(dispatch),
    "H18: a hand-off counts as in flight in plan() from the start command until seen or 5 min (S5, unchanged)");
  ok(/if \(!idle && !sameFile\(sj, l\.fp, l\.idx\)\) continue;/.test(dispatch) && /l\.startingFile = sj\.file; l\.startingJob = sj\.id;\n      if \(idle\)/.test(dispatch),
    "H18: the running entry is attributed to the hand-off's job while the printer reports that file, not only while the lane looks idle");
};

if (require.main === module) {
  let pass = 0, fail = 0;
  module.exports((c, n, d) => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } })
    .then(() => { console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
