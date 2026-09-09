// core/settings.js — public config view, /api/config, /api/version
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const fs = require("fs");

module.exports = function (hub) {
const { CONFIG_PATH, MODULE_DEFAULTS, PORT, VERSION, app, loadConfig, printerOrigin, typeBySlug } = hub;


// ---- Settings: read/write config from the UI (no file editing) ----
function publicCfg() {
  return { gcodeFolder: hub.CFG.gcodeFolder || "./gcode", folderResolved: hub.FOLDER, printers: hub.PRINTERS,
    types: hub.TYPES.map(t => ({ slug: t.slug, label: t.label, accent: t.accent, builtin: !!t.builtin, warning: hub.TYPE_WARNINGS[t.slug] || null })),
    tip: hub.CFG.tip || null, features: { ...hub.FEATURES },
    // what config.json ASKS for - differs from `features` until a restart
    featuresConfig: { ...MODULE_DEFAULTS, ...((hub.CFG.features && typeof hub.CFG.features === "object") ? hub.CFG.features : {}) },
    configured: hub.PRINTERS.length > 0 };
}

app.get("/api/config", (req, res) => res.json(publicCfg()));

app.get("/api/version", (req, res) => res.json({ version: VERSION }));


app.post("/api/config", (req, res) => {
  const b = req.body || {};
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (hub.CFG.gcodeFolder || "./gcode"),
    port: PORT,
    types: hub.CFG.types,   // types are managed via /api/types — a config save never drops them
    printers: Array.isArray(b.printers)
      ? b.printers.filter(p => p && p.url).map(p => {
          // Instance → type binding. Unknown/missing type falls back to the
          // grandfathered U1 so a stale frontend can't orphan a printer.
          const rec = { name: String(p.name || p.url), url: String(p.url), type: (p.type && typeBySlug(String(p.type))) ? String(p.type) : "u1" };
          // Plug descriptor. The settings form now sends the plug explicitly:
          //  - a valid {type,...} to set it,
          //  - null to clear it,
          //  - (field omitted) to preserve whatever's already there — this last case
          //    covers a hand-edited config saved from an older frontend that doesn't
          //    know about plugs. Validate the shape so a bad payload can't write junk.
          let plug = p.plug;
          if (plug === undefined) {
            const ex = (hub.CFG.printers || []).find(x => x && x.url === p.url);
            if (ex && ex.plug) plug = ex.plug;
          }
          if (plug && plug.type === "shelly" && plug.ip) {
            rec.plug = { type: "shelly", ip: String(plug.ip).trim() };
          } else if (plug && plug.type === "url" && plug.on && plug.off) {
            rec.plug = { type: "url", on: String(plug.on).trim(), off: String(plug.off).trim() };
          }
          // anything else (null, unknown type, missing fields) → no plug written
          return rec;
        })
      : (hub.CFG.printers || []),
    tip: (b.tip && (b.tip.url || b.tip.label)) ? { label: String(b.tip.label || "Buy me a beer"), url: String(b.tip.url || "") } : (b.tip === null ? null : (hub.CFG.tip || null)),
    // Feature flags from the Settings UI. Only known module names, booleans
    // only; field omitted = older frontend - preserve. Modules mount at
    // boot, so changes take effect on the next restart (the UI says so).
    features: (b.features && typeof b.features === "object")
      ? Object.fromEntries(Object.keys(MODULE_DEFAULTS).filter(k => k in b.features).map(k => [k, b.features[k] !== false]))
      : (hub.CFG.features || undefined)
  };
  // Duplicate-printer guard (v2.12): refuse the save — nothing is written —
  // and name both offenders so the fix is obvious from the error alone.
  if (Array.isArray(b.printers)) {
    const seen = new Map();
    for (const p of next.printers) {
      const o = printerOrigin(p.url);
      if (seen.has(o)) {
        return res.status(409).json({ error: "\"" + seen.get(o) + "\" and \"" + p.name + "\" point at the same printer (" + o.replace(/:80$/, "") + ") — give each printer its own address" });
      }
      seen.set(o, p.name);
    }
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    loadConfig();
    res.json({ ok: true, ...publicCfg() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
};
