// core/modules.js — feature-module loader and the ctx modules receive
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const express = require("express");
const fs = require("fs");
const path = require("path");

module.exports = function (hub) {
const { ASSET_DIR, AUTH, BASE_DIR, INPLACE_MODULES, PRINTER_PROXY_PREFIX, VERSION, app, detectCaps, fleetSnapshot, hublog, loadoutSnapshot, paletteForFile, safeFile, saveConfigFile, typeBySlug, typeFolder } = hub;


// ---- Feature module loader (v2.11) ------------------------------------------
// Modules are plain files in modules/, each exporting register(ctx). The
// require table is STATIC on purpose: @yao-pkg/pkg follows static requires
// into the binary; a dynamic directory scan would ship broken executables.
// The ctx is the ONLY door a module gets — CFG/PRINTERS/TYPES are reassigned
// on every config save, so ctx exposes live getters, never captured
// references. Cross-module needs go through provide()/use(): the owning
// module publishes a capability, consumers cope with undefined when it's off.
const MODULE_TABLE = {
  power: require("../modules/power.js"),
  camera: require("../modules/camera.js"),
  spools: require("../modules/spools.js"),
  mixer: require("../modules/mixer.js"),
  dispatch: require("../modules/dispatch.js"),
  slicing: require("../modules/slicing.js"),
  // AFTER dispatch on purpose: resources consumes the "dispatch.jobs"
  // capability, and provide()/use() is resolved at call time, not registration
  // time — but keeping the order honest makes the dependency readable.
  resources: require("../modules/resources.js"),
  // v2.24: one-way Spoolman import. AFTER spools and resources because it
  // writes through their provide()d capabilities and nothing reads its own.
  spoolman: require("../modules/spoolman.js"),
  // v2.24: ntfy push notifications. Listens on hub.events; provides notify.send.
  notify: require("../modules/notify.js"),
  // v2.25: AI pre-flight with the person's own Anthropic key. Inert without one.
  advisor: require("../modules/advisor.js"),
  // v2.26: the 3MF model library (Models tab). Reads a folder, opens Orca.
  // v2.28: also provides models.open/models.info, which advisor's 3MF
  // suggester uses at call time (provide/use resolves late, so advisor
  // registering first is fine).
  models: require("../modules/models.js"),
  // v2.28: "worth printing?" - three numbers on the job card from the file's
  // own grams and time. Pure arithmetic and two settings; provides margin.quote.
  margin: require("../modules/margin.js"),
  // v2.37: the printer logbook and maintenance schedule. Listens on hub.events
  // (pauses/errors with a reason, maintenance mode), uses notify.send at call
  // time, provides logbook.cards for the fleet snapshot's `upkeep` field.
  logbook: require("../modules/logbook.js"),
  // v2.27: SF3D timelapse upload. Listens on hub.events ("print.done"),
  // pulls the printer's own rendered clip and hands it to the SF3D edge
  // function. No route, no UI - it only reacts to events dispatch already
  // publishes, so ordering relative to the others here doesn't matter.
  timelapse: require("../modules/timelapse.js"),
  // Last on purpose: it owns no data anyone else reads, and its only side
  // effect is one outbound HTTPS GET that must never delay a registration
  // above it.
  updates: require("../modules/updates.js"),
  // v2.21: reverse-proxies each printer's own Klipper/Fluidd UI under /p/<id>/
  // so it rides the Hub's tunnel and its password gate. Registered last-ish for
  // the same reason as updates — it provides nothing, and its route is a
  // catch-all under one prefix that must not shadow anything above it.
  klipper: require("../modules/klipper.js")
};

const CAPS_PROVIDED = new Map();

const UPGRADE_HANDLERS = [];   // v2.21: see ctx.onUpgrade below

// Parse "estimated printing time (normal mode) = 1d 2h 3m" from gcode text.
// v2.28: the reading moved to parser.js (estMinutes) so modules/margin.js
// reads the same string the same way; this stays as the name callers know.
const parseEstMinutes = text => (/estimated printing time/i.test(text || "") ? require("../parser.js").estMinutes(text) : null);

// One-call file facts for modules (dispatch): colors + class + time estimate.
// Reads the same cached palette as /api/print; the estimate comes from a
// bounded read (Orca writes it in the config tail, our fixtures likewise).
function fileInfoForModules(name, typeSlug) {
  const t = typeBySlug(String(typeSlug || "u1")) || typeBySlug("u1");
  const fp = safeFile(name, t);
  if (!fp || !fs.existsSync(fp)) return { exists: false };
  const pal = paletteForFile(name, t) || {};
  let est = null;
  try {
    const st = fs.statSync(fp);
    const CH = 262144;
    const fd = fs.openSync(fp, "r");
    try {
      const head = Buffer.alloc(Math.min(CH, st.size));
      fs.readSync(fd, head, 0, head.length, 0);
      est = parseEstMinutes(head.toString("utf8"));
      if (est === null && st.size > CH) {
        const tail = Buffer.alloc(CH);
        fs.readSync(fd, tail, 0, CH, st.size - CH);
        est = parseEstMinutes(tail.toString("utf8"));
      }
    } finally { fs.closeSync(fd); }
  } catch {}
  return { exists: true, colors: pal.colors || [], estMinutes: est,
           multi: !!(pal.isFS || (pal.usedCount || 0) > 1) };
}


const MODULE_CTX = Object.freeze({
  app, express, hublog,
  baseDir: BASE_DIR, assetDir: ASSET_DIR,
  // v2.18: modules/updates.js compares this against the release manifest. A
  // plain value, not a getter — VERSION is a build-time constant.
  version: VERSION,
  detectCaps: (idx) => detectCaps(idx),
  fileInfo: (name, typeSlug) => fileInfoForModules(name, typeSlug),
  // v2.12: slicing writes produced gcode into a type's folder; fileInfo only
  // reads. Live lookup, same reassignment-safety rules as the getters below.
  gcodeFolderFor: (slug) => typeFolder(typeBySlug(String(slug || "u1")) || typeBySlug("u1")),
  // v2.23 PERF: { size, mtime } for a library file from the library's own
  // snapshot - no stat against the share. `null` when the snapshot exists and
  // does not contain the file (deleted, or arrived since the last refresh);
  // `undefined` when there is no snapshot yet (boot), so a caller can tell
  // "missing" from "don't know yet". Callers needing certainty stat.
  fileStat: (name, slug) => {
    const t = typeBySlug(String(slug || "u1")) || typeBySlug("u1");
    const snap = t && hub.librarySnapshot ? hub.librarySnapshot(t) : null;
    if (!snap) return undefined;
    const f = snap.files.find(x => x.name === path.basename(String(name || "")));
    return f ? { size: f.size, mtime: f.mtime } : null;
  },
  // v2.12: modules may own a slice of config.json (slicing does — its slicer
  // block is UI-editable). They mutate ctx.cfg.<their key> and persist here.
  saveConfig: () => saveConfigFile(),
  loadout: (idx) => loadoutSnapshot(idx),
  spoolShelf: () => { try { return (JSON.parse(fs.readFileSync(path.join(BASE_DIR, "spools.json"), "utf8")) || {}).spools || {}; } catch { return {}; } },
  fleet: () => fleetSnapshot(),
  // v2.24: fleet edges. ctx.events.on("print.done", ev => …) — see core/events.js
  // for the event names and payloads. Listeners run inside the poller; keep
  // them quick and never let them throw.
  get events() { return hub.events; },
  get cfg() { return hub.CFG; },
  get printers() { return hub.PRINTERS; },
  get types() { return hub.TYPES; },
  get features() { return hub.FEATURES; },
  provide: (key, fn) => CAPS_PROVIDED.set(key, fn),
  use: key => CAPS_PROVIDED.get(key),
  // v2.21, for modules that proxy a WebSocket (klipper). A handler returns
  // true if it took the socket; the first taker wins and anything nobody
  // claims is closed rather than left hanging. Registered into a list because
  // modules load BEFORE app.listen() — there is no server object yet.
  onUpgrade: fn => UPGRADE_HANDLERS.push(fn),
  // The same predicate the Express gate uses. An upgrade never reaches
  // middleware, so a proxying module has to ask.
  isAuthed: req => AUTH.isAuthed(req),
  proxyPrefix: PRINTER_PROXY_PREFIX
});

for (const [name, mod] of Object.entries(MODULE_TABLE)) {
  if (hub.FEATURES[name] === false) { hublog("info", "module '" + name + "' disabled by profile/config"); continue; }
  try { mod.register(MODULE_CTX); hublog("info", "module '" + name + "' registered"); }
  catch (e) { hublog("error", "module '" + name + "' failed to register: " + e.message); }
}

for (const { name, fn } of INPLACE_MODULES) {
  if (hub.FEATURES[name] === false) { hublog("info", "module '" + name + "' (in-place) disabled by profile/config"); continue; }
  try { fn(); hublog("info", "module '" + name + "' (in-place) registered"); }
  catch (e) { hublog("error", "module '" + name + "' failed to register: " + e.message); }
}

Object.assign(hub, { CAPS_PROVIDED, UPGRADE_HANDLERS });
};
