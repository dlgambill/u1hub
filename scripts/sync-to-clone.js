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
  "server.js", "package.json", "update.json", ".gitignore", "Dockerfile",
  // v2.23: the core split. server.js is the composition root; these load in order.
  "core/log.js", "core/config.js", "core/records.js", "core/app.js", "core/library.js",
  "core/print.js", "core/fleet.js", "core/telemetry.js", "core/thumbs.js", "core/filament.js",
  "core/network.js", "core/settings.js", "core/modules.js",
  "scripts/split-core.js", "scripts/check-core.js",
  "CLAUDE.md", "MISTAKES.md", "README.md", "HANDOFF.md", "share-posts.md",
  "auth.js",
  "modules/dispatch.js", "modules/resources.js", "modules/updates.js", "modules/klipper.js",
  "public/index.html", "public/app.js", "public/gold.css", "scripts/split-app.js",
  "public/modules/dispatch-ui.js", "public/modules/resources-ui.js", "public/modules/updates-ui.js",
  "test/run-tests.js",
  "test/gold-falsify-standalone.js", "test/updates-standalone.js", "test/affiliate-standalone.js",
  "test/inventory-reconcile-standalone.js", "test/mock-moonraker.js",
  "scripts/run-harness.cmd", "scripts/refresh-filament-db.js",
  "scripts/falsify-reconcile.js", "scripts/falsify-matchmaint.js",
  "scripts/falsify-replenish.js", "scripts/gate-klipper.js", "scripts/gate-dispatch.js",
  "scripts/peek-gcode-store.js",
  "scripts/boot-4546.cmd", "scripts/stop-4546.cmd",
  "scripts/restart-4545.cmd", "scripts/seed-4546.js", "scripts/sync-to-clone.js",
  "scripts/shoot-docs.js",
  // v2.23: the tester zip builder, the access-log and page-traffic peeks that
  // found the slow spots, and the two bridge helpers the others lean on.
  "scripts/pack-tester-zip.js", "scripts/peek-access.js", "scripts/peek-tab-traffic.js",
  "scripts/failscan.js", "scripts/grepcss.js", "scripts/drift-scan.js",
  // Found by drift-scan.js on 2026-09-09: rfid.js had carried the v2.12
  // /api/spools/update route on X: since August without ever being in this
  // list, so every GitHub build since shipped a Spools tab whose edit button
  // hit a 404. A file this list forgets is a file the release forgets.
  "rfid.js", "filament-swatches.json", "fs-colors.js", "parser.js", "tunnel.js", "capture-proxy.js",
  "modules/camera.js", "modules/mixer.js", "modules/power.js", "modules/slicing.js", "modules/spools.js",
  "public/modules/slicing-ui.js", "public/auth.html", "public/fs-colors.html", "public/labels.html",
  "public/manifest.json", "public/sw.js",
  // v2.21 README refresh: the reshot screenshots and the long-form archive.
  "docs/CHANGELOG.md",
  "docs/dashboard.png", "docs/dispatch.png", "docs/resources.png",
  "docs/spools-inventory.png", "docs/spool-match.png", "docs/features-panel.png",
  "docs/klipper-proxy.png", "docs/remote-phone.png"
];

// v2.23 (2026-09-09): everything git already tracks in the clone is synced
// too, so a tracked file can never again fall out of the release just because
// this list forgot it (rfid.js did, for five releases). Still not a walk: the
// set is the repo's own index, and NEVER below still wins.
try {
  const tracked = require("child_process").execSync("git ls-files", { cwd: DST, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  for (const f of tracked) if (!FILES.includes(f) && !/^gcode\//.test(f)) FILES.push(f);
} catch (e) { console.log("could not read the clone's index (" + e.message.split("\n")[0] + ") - using the explicit list only"); }

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
