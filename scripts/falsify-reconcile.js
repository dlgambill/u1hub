// Rule 6: a check that has never failed has never been tested.
// Mutates modules/resources.js in place, runs the standalone suite, restores.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SRC = path.join(REPO, "modules", "resources.js");
const SUITE = path.join(REPO, "test", "inventory-reconcile-standalone.js");
const original = fs.readFileSync(SRC, "utf8");

const MUTATIONS = [
  ["drop the authoritative guard (delete on a failed share read)",
   'if (!authoritative || referenced.has(id)) { kept.push(row); continue; }',
   'if (referenced.has(id)) { kept.push(row); continue; }'],
  ["drop the reference check (eat numbers a colour still points at)",
   'if (!authoritative || referenced.has(id)) { kept.push(row); continue; }',
   'if (!authoritative) { kept.push(row); continue; }'],
  ["do not actually delete (old behaviour: report forever)",
   '    dropped.push(row);\n    delete inv[id];',
   '    dropped.push(row);'],
  ["treat a parse error as an authoritative empty shelf",
   'raw = {}; authoritative = !!(e && e.code === "ENOENT");',
   'raw = {}; authoritative = true;'],
  ["compare color_map values without String()",
   'const referenced = new Set(Object.values(cm).map(String));',
   'const referenced = new Set(Object.values(cm));']
];

let allFailed = true;
try {
  for (const [name, from, to] of MUTATIONS) {
    if (!original.includes(from)) {
      console.log("!! MUTATION ANCHOR MISSING: " + name);
      allFailed = false;
      continue;
    }
    fs.writeFileSync(SRC, original.replace(from, to));
    let failed = false, out = "";
    try {
      out = execFileSync(process.execPath, [SUITE], { encoding: "utf8" });
    } catch (e) {
      failed = true;
      out = String(e.stdout || "");
    }
    const line = (out.match(/\d+ passed, \d+ failed/) || ["?"])[0];
    console.log((failed ? "  ✓ caught  " : "  ✗ MISSED  ") + name + "   [" + line + "]");
    if (!failed) allFailed = false;
  }
} finally {
  fs.writeFileSync(SRC, original);
}
console.log(allFailed ? "\nevery mutation was caught" : "\nAT LEAST ONE MUTATION SURVIVED");
process.exit(allFailed ? 0 : 1);
