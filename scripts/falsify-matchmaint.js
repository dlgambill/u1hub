// Rule 6 for the two Match-tab maintenance checks: prove each regex fails when
// the thing it claims to check is removed. Reads index.html, mutates the STRING
// in memory (never the file), applies the same regexes run-tests.js uses.
const fs = require("fs");
const path = require("path");
const idx = fs.readFileSync(path.resolve(__dirname, "..", "public", "index.html"), "utf8");

const CHECKS = [
  ["Match card marked", s => /class="matchcard[^"]*p\.maintenance\s*\?/.test(s)],
  ["tag + card style",  s => /mmaint/.test(s) && /\.matchcard\.maint/.test(s)]
];
const MUTANTS = [
  ["baseline (unmutated)", s => s],
  ["class expression loses the maintenance branch",
   s => s.replace(`class="matchcard\${open?' open':''}\${p.maintenance?' maint':''}"`,
                  `class="matchcard\${open?' open':''}"`)],
  ["the visible tag is dropped from the head", s => s.replace(/mmaint/g, "xxnope")],
  ["the card style is dropped", s => s.replace(/\.matchcard\.maint/g, ".matchcard.xxnope")]
];

let bad = 0;
for (const [mname, mutate] of MUTANTS) {
  const s = mutate(idx);
  if (mname.startsWith("baseline") ? false : s === idx) {
    console.log("!! MUTATION DID NOTHING: " + mname); bad++; continue;
  }
  const res = CHECKS.map(([cname, fn]) => cname + "=" + (fn(s) ? "pass" : "FAIL"));
  console.log("  " + mname + "  ->  " + res.join(", "));
}
const base = CHECKS.every(([, fn]) => fn(idx));
console.log(base ? "\nbaseline is green" : "\nBASELINE IS RED — the feature is not actually there");
process.exit(base && !bad ? 0 : 1);
