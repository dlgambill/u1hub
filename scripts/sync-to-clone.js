// scripts/sync-to-clone.js — RETIRED 2026-09-09.
//
// From 2026-08 to 2026-09-09 the Hub was edited and run from a staging copy on
// X:\u1-print-hub and this script copied an explicit file list into the git
// clone before each push. That split cost real bugs (rfid.js went five
// releases without being staged; CLAUDE.md diverged in both directions), so
// Danny retired it: the clone at C:\Users\Danny\code\u1-print-hub is now the
// ONLY tree - edited, run (port 4545) and committed in place - and the gcode
// library lives at X:\gcode via config.json's gcodeFolder.
//
// Kept as a stub so an old habit or an old note cannot copy anything anywhere.
console.log("sync-to-clone is retired (2026-09-09): there is no staging copy.");
console.log("Edit, test and commit in C:\\Users\\Danny\\code\\u1-print-hub directly.");
process.exit(0);
