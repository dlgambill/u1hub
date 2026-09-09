// scripts/split-app.js — move index.html's inline application script into
// public/app.js (v2.23 PERF). An external script with a versioned URL is
// cached AND gets V8's compiled-code cache on repeat loads; an inline script
// is re-parsed and re-compiled on every visit, which on a phone was most of
// the time-to-cards. Behavior-preserving: the <script src> sits exactly where
// the inline block was, so execution order (HUB_FEATURES -> app -> modules) is
// unchanged. `const VERSION` stays inline in the page: the version-discipline
// rule and its harness check read it from index.html, and a top-level const in
// one classic script is visible to the next.
//   node scripts/split-app.js          # report
//   node scripts/split-app.js --apply  # write public/app.js + index.html
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const BACKUP = path.join(ROOT, "scripts", "_index.pre-split.html");
const IDX = path.join(ROOT, "public", "index.html");
const src = fs.readFileSync(fs.existsSync(BACKUP) ? BACKUP : IDX, "utf8");
const APPLY = process.argv.includes("--apply");

const modAt = src.indexOf("<!-- @client-modules -->");
if (modAt < 0) { console.error("no @client-modules placeholder"); process.exit(1); }
const close = src.lastIndexOf("</script>", modAt);
const open = src.lastIndexOf("<script>", close);
if (open < 0 || close < 0) { console.error("could not find the inline app script"); process.exit(1); }
let js = src.slice(open + "<script>".length, close);
const vm = /^const VERSION = "([^"]+)";\r?\n/m.exec(js);
if (!vm) { console.error("const VERSION not found at the top of the script"); process.exit(1); }
js = js.replace(vm[0], "");                                     // VERSION stays in the page
const before = src.slice(0, open), after = src.slice(close + "</script>".length);
const header = "// public/app.js — U1 Print Hub application script (v2.23: moved out of\n" +
  "// index.html so the browser can cache it, compiled, between releases; the\n" +
  "// page keeps `const VERSION` inline and this file reads it as a global).\n" +
  "// Served as app.js?v=<VERSION> — see core/app.js serveIndex.\n";
const page = before + "<script>const VERSION = \"" + vm[1] + "\";</script>\n<script src=\"app.js\"></script>" + after;
console.log("inline script: " + js.split("\n").length + " lines -> public/app.js; index.html " + src.split("\n").length + " -> " + page.split("\n").length + " lines");
if (!APPLY) { console.log("dry run — pass --apply"); process.exit(0); }
if (!fs.existsSync(BACKUP)) fs.writeFileSync(BACKUP, src);
fs.writeFileSync(path.join(ROOT, "public", "app.js"), header + js);
fs.writeFileSync(IDX, page);
console.log("WROTE public/app.js and public/index.html (original kept at scripts/_index.pre-split.html)");
