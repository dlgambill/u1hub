// test/updates-standalone.js — the version-ordering table for modules/updates.js.
//
// Kept out of run-tests.js because it needs no Hub, no network and no fixtures:
// it is pure comparison logic, and logic this easy to get wrong deserves to be
// runnable in under a second while you are editing it.
//
//   node test/updates-standalone.js
//
// The bug this exists to prevent: comparing versions as strings. "2.9.0" sorts
// AFTER "2.17.0" lexically, so a naive check tells everyone on the newest build
// that they are behind — the single most embarrassing possible failure for an
// update notifier. The last section proves the naive method actually fails on
// this table, so the checks above it are demonstrably load-bearing.

"use strict";
const { cmpVersion } = require("../modules/updates.js");

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail === undefined ? "" : "  " + JSON.stringify(detail))); }
};

// [a, b, expected sign of cmpVersion(a, b)]
const TABLE = [
  ["2.9.0",      "2.17.0",   -1, "double-digit minor beats single digit (the string-compare trap)"],
  ["2.17.0",     "2.9.0",     1, "…and the same comparison inverted"],
  ["2.17.0",     "2.17.0",    0, "identical versions are equal"],
  ["2.17.0",     "2.18.0",   -1, "ordinary minor bump"],
  ["2.17.0",     "2.17.1",   -1, "patch bump"],
  ["3.0.0",      "2.99.99",   1, "major wins over everything below it"],
  ["2.18.0-rc1", "2.18.0",   -1, "a prerelease is not the release"],
  ["2.18.0",     "2.18.0-rc1", 1, "…and the release beats it"],
  ["v2.18.0",    "2.18.0",    0, "a leading v is cosmetic"],
  ["2.18",       "2.18.0",    0, "a missing patch component reads as zero"],
  ["",           "2.18.0",   -1, "an empty local version is behind everything"],
  ["2.18.0",     "",          1, "…and an empty manifest version is never newer"],
  ["2.18.0",     "garbage",   1, "an unparseable manifest version cannot claim to be newer"]
];

for (const [a, b, want, why] of TABLE) {
  const got = cmpVersion(a, b);
  ok(Math.sign(got) === want, why + "  [" + JSON.stringify(a) + " vs " + JSON.stringify(b) + "]",
    { want, got });
}

// A comparator has to be internally consistent, not merely right on pairs we
// happened to think of. Sorting a deliberately jumbled list must reproduce the
// known-good order exactly.
{
  const jumbled = ["2.17.0", "2.9.0", "3.0.0", "2.18.0-rc1", "2.18.0", "2.10.4", "1.99.99", "2.17.1"];
  const expect  = ["1.99.99", "2.9.0", "2.10.4", "2.17.0", "2.17.1", "2.18.0-rc1", "2.18.0", "3.0.0"];
  const sorted = jumbled.slice().sort(cmpVersion);
  ok(JSON.stringify(sorted) === JSON.stringify(expect),
    "sorting a jumbled release history reproduces the real order",
    { sorted, expect });
}

// Falsification (rule #6): show the naive implementation actually fails this
// table. If string comparison passed, the checks above would be decorative.
{
  const naive = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const wouldFail = TABLE.filter(([a, b, want]) => Math.sign(naive(a, b)) !== want);
  ok(wouldFail.length > 0,
    "string comparison demonstrably fails this table — the checks above are load-bearing",
    { failures: wouldFail.length, firstExample: wouldFail[0] && wouldFail[0].slice(0, 3) });
  // And name the specific case, so the reason survives in the output.
  ok(Math.sign(naive("2.9.0", "2.17.0")) === 1 && cmpVersion("2.9.0", "2.17.0") === -1,
    "specifically: string compare calls 2.9.0 NEWER than 2.17.0; cmpVersion does not");
}

console.log("\n" + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
