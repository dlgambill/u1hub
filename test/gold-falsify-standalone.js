// test/gold-falsify-standalone.js — rule #6 evidence for the v2.17 gold.css
// checks in run-tests.js.
//
// A check that has never been seen to fail is not a check. Running the full
// harness once per mutation would mean ten Hub boots over a 60-second bridge,
// so this does the honest equivalent: it lifts each predicate out of
// run-tests.js verbatim, runs it against the real file (must PASS), then
// against a copy mutated to break exactly that property (must FAIL).
//
//   node test/gold-falsify-standalone.js
//
// Green here means every v2.17 check is load-bearing. If a mutation still
// passes, the check is decorative and the harness is lying about coverage.

"use strict";
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const GOLD = fs.readFileSync(path.join(REPO, "public", "gold.css"), "utf8");
const PAGE = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");

let pass = 0, fail = 0;

// Each entry: the predicate exactly as run-tests.js evaluates it, plus a
// mutation that should defeat it and nothing else.
const CASES = [
  {
    name: "--accent aliases --signal",
    pred: g => /--accent:\s*var\(--signal\)/.test(g),
    // The bug this check exists to prevent: the alias reverts to a literal and
    // .fmembar silently stops following applyAccent() again.
    break_: g => g.replace(/--accent:\s*var\(--signal\)/, "--accent:#FFB200")
  },
  {
    name: "--card aliases --panel",
    pred: g => /--card:\s*var\(--panel\)/.test(g),
    break_: g => g.replace(/--card:\s*var\(--panel\)/, "--card:#161a22")
  },
  {
    name: "all five radius tokens defined",
    pred: g => ["--r-xs", "--r-sm", "--r-md", "--r-lg", "--r-pill"]
      .every(t => new RegExp(t + ":").test(g)),
    break_: g => g.replace("--r-pill:", "--r-round:")
  },
  {
    name: "gold.css never assigns a semantic colour token",
    pred: g => !/--(signal|ok|bad|busy|idle)\s*:/.test(g),
    // The failure mode: someone "fixes" a colour here and freezes the per-type
    // accent for every non-U1 fleet.
    break_: g => g + "\n:root{--signal:#FFB200;}\n"
  },
  {
    name: "no `transition: all`",
    pred: g => !/transition:\s*all\b/.test(g),
    break_: g => g + "\n.pcard{transition:all .2s;}\n"
  },
  {
    name: "no CSS keyword easing in a transition",
    pred: g => (g.match(/transition:[^;]*\b(ease|ease-in|ease-out|ease-in-out|linear)\b[^;]*/g) || [])
      .filter(s => !/var\(--ease/.test(s)).length === 0,
    break_: g => g + "\n.mmore{transition:color .2s ease-in-out;}\n"
  },
  {
    name: "every post-2.11 control has a focus-visible ring",
    pred: g => [".mmore", ".invf", ".statsbtn", ".camopen", ".matchhead",
                ".qhead", ".pnlink", ".dsp-toggle", ".dsp-pd"]
      .filter(sel => !new RegExp(sel.replace(".", "\\.") + "[^,{]*:focus-visible").test(g))
      .length === 0,
    break_: g => g.replace(".mmore:focus-visible,", "")
  },
  {
    name: "source-filter checkboxes are focusable again",
    pred: g => /\.srcbar input\{[\s\S]*?display:revert/.test(g),
    break_: g => g.replace("display:revert", "display:none")
  }
];

for (const c of CASES) {
  const onReal = c.pred(GOLD);
  const onBroken = c.pred(c.break_(GOLD));
  const good = onReal === true && onBroken === false;
  console.log((good ? "  ok   " : "  FAIL ") + c.name +
    (good ? "" : "  (real=" + onReal + " mutated=" + onBroken + ")"));
  good ? pass++ : fail++;
}

// The two page-level checks, falsified the same way against index.html.
{
  const linkAfterStyle = p => {
    const s = p.indexOf("</style>"), l = p.indexOf('href="gold.css"');
    return s > -1 && l > s;
  };
  const real = linkAfterStyle(PAGE);
  // Move the link above the inline block: the override layer would lose the
  // cascade and every rule in gold.css would quietly stop applying.
  const moved = PAGE.replace('<link rel="stylesheet" href="gold.css">', "")
    .replace("<style>", '<link rel="stylesheet" href="gold.css">\n<style>');
  const broken = linkAfterStyle(moved);
  const good = real === true && broken === false;
  console.log((good ? "  ok   " : "  FAIL ") + "gold.css is linked after the inline <style>" +
    (good ? "" : "  (real=" + real + " mutated=" + broken + ")"));
  good ? pass++ : fail++;
}

console.log("\n" + pass + " falsified, " + fail + " not falsifiable\n");
process.exit(fail ? 1 : 0);
