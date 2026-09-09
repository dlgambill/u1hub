// core/log.js — ring-buffer logger, install paths, default config
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");
const path = require("path");

module.exports = function (hub) {


// ---- Ring-buffer logger (v2.9, beta diagnostics) ----------------------------
// Keeps the last ~500 log lines in memory so /api/diagnostics can hand a beta
// tester's GitHub issue real evidence (capability detections, class-guard
// hits, migrations, errors) without the Hub ever writing a log file or
// phoning home. console.warn/error are mirrored in so uncaught noise is
// captured too; hublog() is the deliberate hook at decision points.
const HUBLOG = [];

const HUBLOG_MAX = 500;

function hublog(level, msg) {
  HUBLOG.push({ t: Date.now(), level, msg: String(msg).slice(0, 500) });
  if (HUBLOG.length > HUBLOG_MAX) HUBLOG.splice(0, HUBLOG.length - HUBLOG_MAX);
}

for (const lvl of ["warn", "error"]) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { try { hublog(lvl, a.map(x => (x && x.stack) || String(x)).join(" ")); } catch {} orig(...a); };
}


// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
// U1HUB_DIR (v2.19) moves every user-editable and stateful file — config.json,
// dispatch.json, spools.json, the lot — to a directory of your choosing, while
// the code keeps running from wherever it is installed. Two reasons it exists:
//
//   * A container or a NAS wants the install read-only and the state on a
//     mounted volume. Until now the two were the same folder by construction.
//   * A second Hub on another port could not be run against the same install
//     without both instances fighting over one dispatch.json. That made a live
//     check of anything that WRITES state impossible without doing it to the
//     production farm's own files.
const IS_PKG = typeof process.pkg !== "undefined";

const BASE_DIR = process.env.U1HUB_DIR
  ? path.resolve(process.env.U1HUB_DIR)
  : (IS_PKG ? path.dirname(process.execPath) : path.join(__dirname, ".."));

const ASSET_DIR = path.join(__dirname, "..");

if (process.env.U1HUB_DIR) {
  try { fs.mkdirSync(BASE_DIR, { recursive: true }); }
  catch (e) { console.error("U1HUB_DIR '" + BASE_DIR + "' could not be created: " + e.message); process.exit(1); }
}


const CONFIG_PATH = path.join(BASE_DIR, "config.json");

const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [], tip: { label: "Buy me a beer 🍺", url: "https://venmo.com/u/dgambill" } };

Object.assign(hub, { ASSET_DIR, BASE_DIR, CONFIG_PATH, DEFAULT_CFG, HUBLOG, IS_PKG, hublog });
};
