// scripts/sync-to-clone.js — copy an EXPLICIT list of source files from the
// staging install (X:) to the git clone (C:), which is the only place commits
// happen. Rule #3.
//
// Explicit list, never a directory walk. A `robocopy /E` here once put 30 GB of
// gcode on the C: drive (MISTAKES.md 2026-08-30), and a walk would also drag
// state files into a repo whose whole discipline is that they stay out.
//
//   node scripts/sync-to-clone.js          # report what differs
//   node scripts/sync-to-clone.js --apply  # copy it

"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..");
const DST = "C:\\Users\\Danny\\code\\u1-print-hub";
const APPLY = process.argv.includes("--apply");

const FILES = [
  "server.js", "package.json", "update.json", ".gitignore",
  "CLAUDE.md", "MISTAKES.md", "README.md", "HANDOFF.md", "share-posts.md",
  "modules/dispatch.js", "modules/resources.js", "modules/updates.js",
  "public/index.html", "public/gold.css",
  "public/modules/dispatch-ui.js", "public/modules/resources-ui.js", "public/modules/updates-ui.js",
  "test/run-tests.js",
  "test/gold-falsify-standalone.js", "test/updates-standalone.js", "test/affiliate-standalone.js",
  "test/inventory-reconcile-standalone.js",
  "scripts/run-harness.cmd", "scripts/refresh-filament-db.js",
  "scripts/falsify-reconcile.js", "scripts/falsify-matchmaint.js",
  "scripts/boot-4546.cmd", "scripts/stop-4546.cmd",
  "scripts/restart-4545.cmd", "scripts/seed-4546.js", "scripts/sync-to-clone.js"
];

// Anything matching these must never be copied, whatever the list above says.
const NEVER = /(^|[\\/])(config|spools|slots|auth|queue|printlog|tunnel|dispatch|slicejobs|resources|update-state)\.json$/i;

let changed = 0, same = 0, missing = 0;
for (const rel of FILES) {
  if (NEVER.test(rel)) { console.log("REFUSED (state file): " + rel); continue; }
  const from = path.join(SRC, rel), to = path.join(DST, rel.replace(/\//g, path.sep));
  if (!fs.existsSync(from)) { console.log("MISSING in staging: " + rel); missing++; continue; }
  const a = fs.readFileSync(from);
  const b = fs.existsSync(to) ? fs.readFileSync(to) : null;
  if (b && a.equals(b)) { same++; continue; }
  console.log((b ? "changed " : "NEW     ") + rel + "   " + a.length + " bytes");
  changed++;
  if (APPLY) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (b) {
      // Overwrite IN PLACE. writeFileSync on an existing file opens with "w",
      // which Windows refuses (EPERM) when the file carries the Hidden
      // attribute — as .gitignore in the clone does. Truncate-and-write through
      // an "r+" handle edits the existing file instead of replacing it, so the
      // attributes survive and the write succeeds.
      const fd = fs.openSync(to, "r+");
      try { fs.ftruncateSync(fd, 0); fs.writeSync(fd, a, 0, a.length, 0); }
      finally { fs.closeSync(fd); }
    } else {
      fs.writeFileSync(to, a);
    }
  }
}
console.log("\n" + changed + " to copy, " + same + " identical, " + missing + " missing");
console.log(APPLY ? "COPIED" : "dry run — pass --apply");
