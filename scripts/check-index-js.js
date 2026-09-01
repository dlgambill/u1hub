// scripts/check-index-js.js — syntax-check every inline <script> in index.html.
// `node --check` only works on .js files, so a typo in the page's own script
// block would otherwise ship silently: the harness boots the SERVER, and never
// parses the page. One vm.Script compile per block catches it in a second.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = process.argv[2] || path.join(__dirname, "..", "public", "index.html");
const html = fs.readFileSync(file, "utf8");
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

let n = 0, bad = 0, m;
while ((m = re.exec(html)) !== null) {
  n++;
  const code = m[1];
  if (!code.trim()) continue;
  const line = html.slice(0, m.index).split("\n").length;
  try { new vm.Script(code, { filename: path.basename(file) + ":block" + n }); }
  catch (e) { bad++; console.log("  SYNTAX ERROR in block " + n + " (starts at line " + line + "): " + e.message); }
}
console.log(path.basename(file) + ": " + n + " inline script block(s), " + bad + " with syntax errors");
process.exit(bad ? 1 : 0);
