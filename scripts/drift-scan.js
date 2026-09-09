// Read-only: which git-tracked files differ between X: (staging) and the C:
// clone, and are NOT in sync-to-clone.js's manifest? Those would silently
// stay stale on C: at the next stage. Run from anywhere.
const fs = require("fs"), path = require("path"), cp = require("child_process");
const X = "X:\\u1-print-hub", C = "C:\\Users\\Danny\\code\\u1-print-hub";
const man = fs.readFileSync(path.join(X, "scripts", "sync-to-clone.js"), "utf8");
const tracked = cp.execSync("git ls-files", { cwd: C, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
let n = 0;
for (const f of tracked) {
  const a = path.join(X, f), b = path.join(C, f);
  if (!fs.existsSync(a)) { console.log("only on C: (not on X:)      " + f); continue; }
  if (!fs.readFileSync(a).equals(fs.readFileSync(b))) {
    const inMan = man.includes('"' + f + '"');
    console.log((inMan ? "differs, in manifest       " : "DIFFERS, NOT IN MANIFEST   ") + f);
    if (!inMan) n++;
  }
}
console.log("\n" + n + " differing file(s) outside the manifest");
