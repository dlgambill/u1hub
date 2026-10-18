// core/spools.js - the one reader and writer of spools.json (H19, 2.45).
//
// spools.json (next to config.json, often on a network share):
//   { spools: { spool_id: identity }, tags: { uid: spool_id }, local: [identity] }
// rfid.js owns the file and rewrites it on every change from its in-memory
// state; everything else (filament memory, the loadout snapshot, the
// diagnostics counter, the Resources shelf, the Dispatch shelf memo) takes a
// fresh read-only peek. Five files used to parse it their own way; now each
// reads the same normalized shape, and the one thing the readers disagreed
// on - whether an empty answer is a FACT or a failed read - is reported
// alongside the data instead of being lost.
//
//   readSpools(baseDir) -> { spools, tags, local, authoritative }
//     spools/tags are always objects and local always an array. A file that
//     does not exist is authoritative (nothing was ever put on the shelf);
//     a parse error or an I/O error is not, and anything that deletes on the
//     strength of "this id is not on the shelf" must check it - one EIO on an
//     SMB share would otherwise look like "the user threw away every roll".
//   writeSpools(baseDir, state) -> true | false
//     A direct write, as rfid.js always did (never a rename - see the note in
//     modules/dispatch.js save() on SMB and rename-over-existing). false and
//     a warn through `log` (optional) when the write fails.
"use strict";

const fs = require("fs");
const path = require("path");

const FILE = "spools.json";

const spoolsPath = baseDir => path.join(baseDir, FILE);

function readSpools(baseDir) {
  let authoritative = false, s = null;
  try {
    s = JSON.parse(fs.readFileSync(spoolsPath(baseDir), "utf8"));
    authoritative = !!(s && typeof s.spools === "object" && s.spools);
  } catch (e) {
    s = null; authoritative = !!(e && e.code === "ENOENT");
  }
  return {
    spools: (s && typeof s.spools === "object" && s.spools) || {},
    tags: (s && typeof s.tags === "object" && s.tags) || {},
    local: Array.isArray(s && s.local) ? s.local : [],
    authoritative
  };
}

function writeSpools(baseDir, state, log) {
  try { fs.writeFileSync(spoolsPath(baseDir), JSON.stringify(state, null, 2)); return true; }
  catch (e) {
    if (typeof log === "function") log("warn", "spools: could not save " + spoolsPath(baseDir) + " - " + (e && e.message || e));
    return false;
  }
}

module.exports = { readSpools, writeSpools, spoolsPath };
