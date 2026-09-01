// Rule 6 for the v2.21 "Replenish on Amazon" checks. Mutates the two files as
// STRINGS in memory and applies the same predicates run-tests.js uses.
const fs = require("fs");
const path = require("path");
const REPO = path.resolve(__dirname, "..");
const idx = fs.readFileSync(path.join(REPO, "public", "index.html"), "utf8");
const rui = fs.readFileSync(path.join(REPO, "public", "modules", "resources-ui.js"), "utf8");
const strip = s => s.split(/\r?\n/).map(l => l.replace(/^\s*\/\/.*$/, "")).join("\n");

const IDX_CHECKS = [
  ["no add-buy-link cell", s => !/invCell\([^)]*"purchase_url"/.test(s)],
  ["spools label",         s => />Replenish on Amazon ↗<\/a>/.test(s)],
  ["no Search/Buy split",  s => !/"(Search|Buy) ↗"/.test(s)]
];
const RUI_CHECKS = [
  ["resources label", s => />Replenish on Amazon<\/a>/.test(strip(s)) && /Replenish on Amazon<\/button>/.test(strip(s))],
  ["no old labels",   s => !/>\s*(Buy|Search)\s*<\/(a|button)>/.test(strip(s))]
];

const IDX_MUTANTS = [
  ["baseline", s => s],
  ["put the add-buy-link cell back",
   s => s.replace('+ invCell(sp.spool_id,"cost_per_roll", v.cost_per_roll, "$", "/roll", "set price")',
                  '+ invCell(sp.spool_id,"cost_per_roll", v.cost_per_roll, "$", "/roll", "set price")\n      + invCell(sp.spool_id,"purchase_url", v.purchase_url, "", "", "add buy link")')],
  ["revert the label to the Search/Buy split",
   s => s.replace('>Replenish on Amazon ↗</a>', '>${v.buy.kind === "search" ? "Search ↗" : "Buy ↗"}</a>')]
];
const RUI_MUTANTS = [
  ["baseline", s => s],
  ["revert the anchor labels to Buy/Search",
   s => s.replace(/>Replenish on Amazon<\/a>/g, ">Buy</a>")],
  ["revert the disabled button label",
   s => s.replace(/Replenish on Amazon<\/button>/g, "Buy</button>")]
];

let bad = 0;
function run(label, src, mutants, checks) {
  console.log("\n== " + label);
  for (const [mname, mutate] of mutants) {
    const s = mutate(src);
    if (mname !== "baseline" && s === src) { console.log("  !! MUTATION DID NOTHING: " + mname); bad++; continue; }
    const res = checks.map(([cname, fn]) => cname + "=" + (fn(s) ? "pass" : "FAIL"));
    console.log("  " + mname.padEnd(42) + res.join(", "));
    if (mname === "baseline" && res.some(r => /FAIL/.test(r))) { console.log("  !! BASELINE RED"); bad++; }
    if (mname !== "baseline" && !res.some(r => /FAIL/.test(r))) { console.log("  !! MUTATION SURVIVED"); bad++; }
  }
}
run("public/index.html", idx, IDX_MUTANTS, IDX_CHECKS);
run("public/modules/resources-ui.js", rui, RUI_MUTANTS, RUI_CHECKS);
console.log(bad ? "\n" + bad + " PROBLEM(S)" : "\nevery mutation was caught, baselines green");
process.exit(bad ? 1 : 0);
