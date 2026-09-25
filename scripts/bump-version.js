// Release bump, byte-exact (no BOM, line endings kept). node bump.js OLD NEW HARNESS_OLD HARNESS_NEW DATE "notes"
const fs = require("fs");
const [OLD, NEW, HOLD, HNEW, DATE, NOTES] = process.argv.slice(2);
if (!OLD || !NEW || !HOLD || !HNEW || !DATE || !NOTES) throw new Error("args");
// A file already at NEW (a rerun after a partial failure) is skipped, not an error.
function edit(file, fn) { const s = fs.readFileSync(file, "utf8"); const out = fn(s); if (out === s) { if (s.includes(NEW)) { console.log("already", file); return; } throw new Error("no change in " + file); } fs.writeFileSync(file, out); console.log("bumped", file); }
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
edit("server.js", s => s.replace(`const VERSION = "${OLD}";`, `const VERSION = "${NEW}";`));
edit("public/index.html", s => s.replace(`index v${OLD} -->`, `index v${NEW} -->`).replace(`const VERSION = "${OLD}";`, `const VERSION = "${NEW}";`));
edit("package.json", s => s.replace(`"version": "${OLD}"`, `"version": "${NEW}"`));
// The lock's first two "version" lines are the package itself (root and
// packages[""]); they are set to NEW whatever they say, because a lane that
// bumps by hand tends to forget the lock (2.31 through 2.34 all did).
edit("package-lock.json", s => { let n = 0; return s.replace(/"version": "\d+\.\d+\.\d+"/g, m => (n++ < 2 ? `"version": "${NEW}"` : m)); });
edit("update.json", s => { const j = JSON.parse(s); if (j.version !== OLD) throw new Error("update.json is " + j.version); j.version = NEW; j.notes = NOTES + " " + j.notes; j.published = DATE; return JSON.stringify(j, null, 2) + (s.endsWith("\n") ? "\n" : ""); });
edit("CLAUDE.md", s => s.replace(`**${HOLD} checks**, expect **${HOLD} passed, 0 failed**`, `**${HNEW} checks**, expect **${HNEW} passed, 0 failed**`));
for (const f of ["server.js", "public/index.html", "package.json", "package-lock.json", "update.json", "CLAUDE.md"]) { const b = fs.readFileSync(f); if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) throw new Error("BOM in " + f); }
console.log("no BOM; update.json:", JSON.parse(fs.readFileSync("update.json", "utf8")).version);
