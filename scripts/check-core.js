// Syntax-check server.js + every core/*.js; print only problems.
const { execFileSync } = require("child_process");
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const files = ["server.js", "public/app.js", ...fs.readdirSync(path.join(ROOT, "core")).filter(f => f.endsWith(".js")).map(f => "core/" + f)];
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: ["ignore", "pipe", "pipe"] }); console.log("ok   " + f); }
  catch (e) { bad++; console.log("FAIL " + f + "\n" + String(e.stderr).split("\n").slice(0, 8).join("\n")); }
}
console.log(bad ? bad + " file(s) failed" : "all clean");
process.exit(bad ? 1 : 0);
