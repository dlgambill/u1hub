// core/config.js — printer types, config load/save, feature flags, capability detection, PORT
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");
const path = require("path");

module.exports = function (hub) {
const { BASE_DIR, CONFIG_PATH, DEFAULT_CFG, IS_PKG, hublog } = hub;


// ---- Printer TYPES (v2.9) ---------------------------------------------------
// A *type* owns a folder + accent + switcher tab; *instances* (physical
// printers) belong to a type and share its folder/accent. Type name is
// organizational ONLY — it never decides which features render. Feature-gating
// stays on capability detection (Klipper objects, see CAPS below). Two
// orthogonal layers, both present: type drives folder + accent + switcher;
// capability detection drives UI.
//
// Folder model (constrained by design):
//   * The built-in U1 type is GRANDFATHERED: locked to the existing flat gcode
//     directory at its current path. Nothing on disk moves on upgrade.
//   * Every NEW type gets an auto-created subfolder <base>/<slug>/. The user
//     names the type; the Hub makes the folder. Nobody browses to an arbitrary
//     path, so the traversal surface stays exactly what safeFile covers today.
//   * The type→folder binding is persisted in config.json and re-validated on
//     every load, so the lock survives restarts and hand-edits can't overlap.
// Reuse-lock rules: collision → rejected; parent/child nesting → rejected;
// unbind/delete → folder freed, gcode files PRESERVED on disk (never deleted);
// folder missing at boot → per-type warning, no crash, no silent recreate.
const U1_ACCENT = "#FFB200"; // today's exact accent — existing users see zero change

const ACCENT_PRESETS = ["#5B9BF0", "#46C18C", "#C77DFF", "#FF7A59", "#3EC9C9", "#E0568C", "#A8C64E", "#F0C33C"];

const BUILTIN_U1 = { slug: "u1", label: "U1", accent: U1_ACCENT, builtin: true };


function slugify(label) {
  return String(label || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}


// Live config — editable from the Settings page, no restart needed.
/* shared state lives on hub: CFG, FOLDER, PRINTERS, TYPES */

hub.TYPE_WARNINGS = {};   // slug -> human-readable boot/validation warning

function typeBySlug(slug) { return (hub.TYPES || []).find(t => t.slug === slug); }

// Immutable slug → directory. Renaming a display label must never move the
// folder or strand queue entries, so the path derives from the slug alone.
function typeFolder(t) { return t.builtin ? hub.FOLDER : path.resolve(hub.FOLDER, t.folder || t.slug); }


// Validate the persisted type list: dedupe slugs, pin the grandfathered U1,
// enforce the reuse-lock rules against hand-edited configs, surface (don't
// crash on, don't silently fix) folders that are missing at startup.
function validateTypes(list) {
  hub.TYPE_WARNINGS = {};
  const out = [];
  const seen = new Set();
  let u1 = (list || []).find(t => t && t.slug === "u1");
  u1 = { ...BUILTIN_U1, label: (u1 && u1.label) || "U1", accent: (u1 && u1.accent) || U1_ACCENT };
  out.push(u1); seen.add("u1");
  for (const t of (list || [])) {
    if (!t || !t.slug || t.slug === "u1") continue;
    const slug = slugify(t.slug);
    if (!slug || seen.has(slug)) { if (slug) hub.TYPE_WARNINGS[slug] = "Duplicate type slug — kept the first entry."; continue; }
    const rec = { slug, label: String(t.label || slug), accent: String(t.accent || ACCENT_PRESETS[out.length % ACCENT_PRESETS.length]), folder: slug };
    const dir = typeFolder(rec);
    // Nesting guard: a type folder must be a DIRECT child of the base folder —
    // never the base itself, never outside it, never inside another type's dir.
    // Auto-created folders always satisfy this; hand-edited configs might not.
    if (dir === hub.FOLDER || path.dirname(dir) !== hub.FOLDER) {
      hub.TYPE_WARNINGS[slug] = "Folder for type '" + rec.label + "' is not a direct subfolder of the gcode base — type disabled to prevent file bleed.";
      continue;
    }
    if (!fs.existsSync(dir)) {
      // Missing at startup: warn, keep the binding, do NOT silently recreate.
      hub.TYPE_WARNINGS[slug] = "Bound folder is missing on disk (" + dir + "). Files are NOT touched — restore the folder or delete the type.";
    }
    out.push(rec); seen.add(slug);
  }
  return out;
}


function saveConfigFile() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(hub.CFG, null, 2)); } catch {}
}


// ---- Feature modules (v2.11): what's core vs. optional ----------------------
// Core = monitor the fleet and print files. Everything else is a module that a
// `features` block in config.json can switch off — and the Lite build is
// nothing more than a profile of these flags (one repo, two downloads, no
// fork). Default is everything ON: an untouched config behaves exactly like
// 2.10. U1HUB_PROFILE=lite (the Lite binary's baked-in default) flips the
// Lite set off unless config.json explicitly says otherwise.
const MODULE_DEFAULTS = { power: true, camera: true, spools: true, match: true, mixer: true, "types-beta": true, dispatch: true, slicing: false, resources: true, updates: true, klipper: true, spoolman: true };

// resources (v2.16) needs dispatch for the schedule; with dispatch off it mounts
// but every endpoint answers "nothing is scheduled" rather than erroring. It
// reads spools.json off disk directly, so it does NOT need the spools module —
// which is why it stays on in Lite, where spools is off.
// slicing ships OFF in 2.12: the engine is built and harness-green, but the CLI
// path has no live hardware gate yet (Rule #1). Code stays; the tab does not.
const LITE_OFF = ["spools", "match", "mixer", "types-beta", "slicing", "spoolman"];  // Lite = core + camera + power + dispatch

hub.FEATURES = { ...MODULE_DEFAULTS };

let FEATURES_LOCKED = false;

function computeFeatures() {
  // Lite is (a) U1HUB_PROFILE=lite in the env, or (b) a packaged binary whose
  // FILENAME contains "lite" — the Lite downloads are the same executables,
  // renamed. No fork, no second build, one repo.
  const exeName = path.basename(process.execPath || "").toLowerCase();
  const lite = String(process.env.U1HUB_PROFILE || "").toLowerCase() === "lite"
            || (typeof IS_PKG !== "undefined" && IS_PKG && exeName.includes("lite"));
  const f = { ...MODULE_DEFAULTS };
  if (lite) for (const k of LITE_OFF) if (k in f) f[k] = false;
  const user = (hub.CFG && typeof hub.CFG.features === "object" && hub.CFG.features) || {};
  for (const k of Object.keys(user)) if (k in f) f[k] = user[k] !== false;
  return f;
}


// In-place module gating (v2.11): some flag-controlled features reassign core
// state (TYPES/QUEUE) or lean on core closures — splitting their few routes
// into files would need a state-setter surface wider than the routes
// themselves. They stay in this file, wrapped in onModule(): the registration
// runs at loader time only when the feature is enabled. Same flag semantics
// as file modules; only the packaging differs.
const INPLACE_MODULES = [];

function onModule(name, fn) { INPLACE_MODULES.push({ name, fn }); }


function loadConfig() {
  try { hub.CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { hub.CFG = { ...DEFAULT_CFG }; }
  // Features are computed ONCE, at boot. Config saves during runtime update
  // config.json (featuresConfig in /api/config shows the pending state) but
  // never the live map — module routes mount at boot, so a live flip would
  // claim a change that hasn't actually happened. Restart applies it, exactly
  // as the Settings panel says.
  if (!FEATURES_LOCKED) { hub.FEATURES = computeFeatures(); FEATURES_LOCKED = true; }
  hub.FOLDER = path.resolve(BASE_DIR, hub.CFG.gcodeFolder || "./gcode");
  hub.PRINTERS = Array.isArray(hub.CFG.printers) ? hub.CFG.printers : [];
  try { fs.mkdirSync(hub.FOLDER, { recursive: true }); } catch {}   // base dir: today's behavior, unchanged
  // v2.8.1 → v2.9 migration: register the built-in U1 type and tag existing
  // printers as U1 instances. No files move — U1 stays flat in the base dir.
  let migrated = false;
  if (!Array.isArray(hub.CFG.types)) { hub.CFG.types = [{ ...BUILTIN_U1 }]; migrated = true; }
  hub.TYPES = validateTypes(hub.CFG.types);
  hub.CFG.types = hub.TYPES;
  for (const p of hub.PRINTERS) {
    if (!p.type || !typeBySlug(p.type)) { p.type = "u1"; migrated = true; }
  }
  if (migrated) saveConfigFile();
  CAPS.clear();            // printer list may have changed — re-detect capabilities
  if (hub.FARM_READY) hub.farmWsRestart(); // reconnect sockets to the new printer list
  // (FARM_READY is a hoisted var — falsy during the initial top-of-file
  // loadConfig(), so sockets first connect once the farm section is defined)
}

// ---- Capability detection (the OTHER layer — drives UI, not folders) --------
// Queried from Klipper's own object list per printer, cached until the config
// changes. print_task_config present = Snapmaker U1-style 4-head machine with
// the color/RFID API; absent = generic Klipper/Moonraker (e.g. Sovol SV06
// Plus ACE on stock Moonraker :7125) — heads counted from extruder objects.
const CAPS = new Map(); // printer idx -> { multiColor, heads } | null while unknown

async function detectCaps(idx) {
  const p = hub.PRINTERS[idx];
  if (!p) return null;
  const hit = CAPS.get(idx);
  if (hit) return hit;
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/printer/objects/list", { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const objects = (((await r.json()).result) || {}).objects || [];
    const multiColor = objects.includes("print_task_config");
    const heads = multiColor ? 4 : Math.max(1, objects.filter(o => /^extruder\d*$/.test(o)).length);
    const caps = { multiColor, heads };
    CAPS.set(idx, caps);
    hublog("info", "caps[" + (p.name || idx) + "]: multiColor=" + multiColor + " heads=" + heads + " (objects: " + objects.length + ")");
    return caps;
  } catch (e) { hublog("warn", "caps[" + (p.name || idx) + "]: detection failed — " + (e && e.message || e)); return null; }
}

loadConfig();

// PORT env override (v2.16): lets a throwaway instance boot alongside the live
// Hub for smoke tests without touching config.json — the live one is often
// mid-print and its config is state, not settings.
const PORT = +process.env.U1HUB_PORT || hub.CFG.port || 4545;

Object.assign(hub, { ACCENT_PRESETS, INPLACE_MODULES, MODULE_DEFAULTS, PORT, detectCaps, loadConfig, onModule, saveConfigFile, slugify, typeBySlug, typeFolder });
};
