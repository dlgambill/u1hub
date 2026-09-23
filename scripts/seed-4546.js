// scripts/seed-4546.js — prepare an isolated state directory for the throwaway
// Hub on 4546 (see boot-4546.cmd).
//
// Why this exists: state used to live beside the install, so a second instance
// shared dispatch.json with production. Any live check of something that WRITES
// — taking a printer down, dismissing an update — would have been performed on
// the real farm's own scheduling file. U1HUB_DIR (v2.19) fixes that; this
// script gives the isolated directory a realistic starting point by copying
// production's state in, so the check runs against real printers and a real
// queue rather than an empty farm.
//
// One-way copy. Nothing here ever writes back to the install.

"use strict";
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..");
const DST = process.argv[2];
if (!DST) { console.error("usage: node scripts/seed-4546.js <state-dir>"); process.exit(1); }

fs.mkdirSync(DST, { recursive: true });

// A snapshot of the farm as it really is, so the throwaway is worth looking at.
// v2.28: models-index.json so the Models tab draws at once instead of walking
// the share for minutes; advisor.json so cached AI answers show without a
// paid call (the key itself rides in config.json, as it always has).
for (const f of ["config.json", "dispatch.json", "spools.json", "slots.json", "resources.json", "models-index.json", "advisor.json", "margin.json", "models-attrs.json"]) {
  const from = path.join(SRC, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DST, f));
}

// gcodeFolder is resolved against the state dir, which is now somewhere in
// %TEMP%. Point it back at the real library so file lists and estimates are the
// real ones — read-only, the Hub never writes into the gcode folder here.
const cfgPath = path.join(DST, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const folder = cfg.gcodeFolder || "./gcode";
cfg.gcodeFolder = path.isAbsolute(folder) ? folder : path.resolve(SRC, folder);
// Never let the throwaway open a tunnel or answer on production's port.
delete cfg.port;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

console.log("seeded " + DST);
console.log("  gcodeFolder -> " + cfg.gcodeFolder);
console.log("  printers    -> " + (cfg.printers || []).length);
