// modules/spoolman.js — one-way import from a Spoolman server (v2.24).
//
// Spoolman (github.com/Donkie/Spoolman) is the inventory a lot of Klipper
// farms already keep: every roll, its filament, what it weighs, what is left.
// People asked for the Hub to read it rather than make them type each spool a
// second time. This module does exactly that and nothing more:
//
//   * ONE direction. Spoolman -> Hub. The Hub never writes to Spoolman, never
//     deducts from it, never archives anything there. If both tools ever wrote
//     to each other the first disagreement would be unresolvable, so the Hub
//     treats Spoolman as the source of truth for the rolls it imports.
//   * Idempotent. A Spoolman spool #12 always becomes Hub spool "spoolman_12"
//     (rfid.js upsertImported). Import twice, get one record, updated. A roll
//     that is loaded in a printer slot stays loaded — slots key on spool_id.
//   * Identity vs inventory stay split the way the Hub already splits them:
//     brand/material/color/temps go to spools.json through the spools module,
//     grams/price go to resources.json through the resources module. This
//     module owns no state file of its own; its only config is the URL.
//   * A Spoolman spool with no color cannot become a Hub spool (the Hub keys
//     everything on hex). It is reported as skipped, by id, not dropped
//     silently.
//   * Archived in Spoolman (or gone from it since the last import) -> the Hub
//     inventory row is marked inactive, never deleted. Nothing is lost if the
//     archive was a mis-click.

"use strict";

const TIMEOUT_MS = 8000;
const SOURCE = "spoolman";

// Spoolman is almost always plain http on a LAN. Accept http or https to any
// host; strip trailing slashes and a pasted "/api/v1" so both forms work.
function normUrl(u) {
  let x;
  try { x = new URL(String(u || "").trim()); } catch { return null; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return null;
  let s = x.origin + x.pathname.replace(/\/+$/, "");
  s = s.replace(/\/api\/v\d+$/i, "");
  return s;
}

// Map one Spoolman spool record to { ident, inv } in Hub terms. Pure, so the
// harness can drive it with fixtures and no server. Returns null when the
// record has no usable color.
function mapSpool(s) {
  const f = (s && s.filament) || {};
  const hex = String(f.color_hex || "").replace(/^#/, "").slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  let hexes = null, style = null;
  if (typeof f.multi_color_hexes === "string" && f.multi_color_hexes.trim()) {
    const list = f.multi_color_hexes.split(",").map(h => h.trim().replace(/^#/, "")).filter(h => /^[0-9a-fA-F]{6}$/.test(h));
    if (list.length >= 2) {
      hexes = list.slice(0, 3);
      // longitudinal = colors change along the strand (rainbow/gradient);
      // coaxial = colors side by side down the length (dual/tri silk).
      style = f.multi_color_direction === "longitudinal" ? "gradient" : "multi";
    }
  }
  const brand = f.vendor && f.vendor.name ? String(f.vendor.name) : "";
  const loc = s.location ? String(s.location) : "";
  const ident = {
    brand,
    material: f.material ? String(f.material) : "",
    color_name: f.name ? String(f.name) : "",
    hex, hexes, color_style: style,
    hot_end_temp: Number.isFinite(+f.settings_extruder_temp) ? +f.settings_extruder_temp : null,
    bed_temp: Number.isFinite(+f.settings_bed_temp) ? +f.settings_bed_temp : null
  };
  const inv = {};
  if (Number.isFinite(+s.remaining_weight)) inv.remaining_g = Math.max(0, +s.remaining_weight);
  if (Number.isFinite(+f.weight) && +f.weight > 0) inv.net_weight_g = +f.weight;
  const price = Number.isFinite(+s.price) ? +s.price : (Number.isFinite(+f.price) ? +f.price : null);
  if (price !== null && price >= 0) inv.cost_per_roll = price;
  if (Number.isFinite(+f.diameter) && +f.diameter > 0) inv.diameter_mm = +f.diameter;
  if (Number.isFinite(+f.density) && +f.density > 0) inv.density = +f.density;
  inv.notes = "Spoolman #" + s.id + (loc ? " · " + loc : "") + (s.lot_nr ? " · lot " + s.lot_nr : "");
  inv.active = !s.archived;
  return { ident, inv, archived: !!s.archived };
}

function register(ctx) {
  const conf = () => (ctx.cfg && typeof ctx.cfg.spoolman === "object" && ctx.cfg.spoolman) || {};
  const urlOf = () => normUrl(conf().url) || null;

  // Everything the Hub knows about a Spoolman roll came from a previous
  // import; ctx.spoolShelf() is the read-only peek at spools.json.
  function importedIds() {
    const out = new Map();
    const shelf = ctx.spoolShelf ? ctx.spoolShelf() : {};
    for (const [sid, sp] of Object.entries(shelf || {}))
      if (sp && sp.imported && sp.imported.source === SOURCE) out.set(sid, sp.imported.id);
    return out;
  }

  async function getJson(base, pathq) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(base + pathq, { signal: ac.signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("HTTP " + r.status + " from " + base + pathq);
      return await r.json();
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("Spoolman did not answer within " + (TIMEOUT_MS / 1000) + " s");
      throw e;
    } finally { clearTimeout(t); }
  }

  function view() {
    const c = conf();
    return {
      url: urlOf() || "",
      configured: !!urlOf(),
      imported_count: importedIds().size,
      last: c.last || null,
      // Off when the spools module is off: nowhere to write identities.
      available: !!(ctx.use && ctx.use("spools.upsertImported"))
    };
  }

  ctx.app.get("/api/spoolman", (req, res) => res.json(view()));

  ctx.app.post("/api/spoolman/settings", (req, res) => {
    const b = req.body || {};
    const cur = conf();
    const next = { ...cur };
    if ("url" in b) {
      const raw = String(b.url || "").trim();
      if (raw) {
        const u = normUrl(raw);
        if (!u) return res.status(400).json({ error: "Spoolman URL must start with http:// or https://" });
        next.url = u;
      } else delete next.url;
    }
    ctx.cfg.spoolman = next;
    ctx.saveConfig();
    res.json(view());
  });

  // Reachability only. GET /api/v1/info is the cheapest thing Spoolman serves.
  ctx.app.post("/api/spoolman/test", async (req, res) => {
    const base = normUrl((req.body && req.body.url) || conf().url);
    if (!base) return res.status(400).json({ error: "No Spoolman URL set" });
    try {
      const info = await getJson(base, "/api/v1/info");
      res.json({ ok: true, url: base, version: info && info.version ? String(info.version) : null });
    } catch (e) {
      res.status(502).json({ ok: false, url: base, error: String((e && e.message) || e) });
    }
  });

  let RUNNING = false;
  ctx.app.post("/api/spoolman/import", async (req, res) => {
    const base = urlOf();
    if (!base) return res.status(400).json({ error: "Set the Spoolman URL first" });
    const upsert = ctx.use && ctx.use("spools.upsertImported");
    const saveSpools = ctx.use && ctx.use("spools.saveImported");
    if (!upsert) return res.status(409).json({ error: "The Spools module is turned off, so there is nowhere to put imported spools" });
    if (RUNNING) return res.status(409).json({ error: "An import is already running" });
    RUNNING = true;
    try {
      const list = await getJson(base, "/api/v1/spool?allow_archived=true");
      if (!Array.isArray(list)) throw new Error("unexpected answer from Spoolman (not a list)");
      const setInv = ctx.use && ctx.use("resources.setInventory");
      const seen = new Set();
      const out = { imported: 0, created: 0, updated: 0, retired: 0, skipped: [] };
      for (const s of list) {
        if (!s || s.id === undefined || s.id === null) continue;
        const m = mapSpool(s);
        if (!m) { out.skipped.push({ id: s.id, reason: "no color set on its filament" }); continue; }
        const r = upsert(SOURCE, s.id, m.ident);
        if (!r || r.error) { out.skipped.push({ id: s.id, reason: (r && r.error) || "rejected" }); continue; }
        seen.add(r.spool_id);
        out.imported++;
        if (r.created) out.created++; else out.updated++;
        if (m.archived) out.retired++;
        if (setInv) setInv(r.spool_id, m.inv, false);
      }
      // Rolls the Hub imported before that Spoolman no longer lists at all:
      // deleted there. Mark inactive, keep the record.
      for (const [sid] of importedIds()) {
        if (seen.has(sid)) continue;
        if (setInv) setInv(sid, { active: false }, false);
        out.retired++;
      }
      if (saveSpools) saveSpools();
      const saveInv = ctx.use && ctx.use("resources.saveInventory");
      if (saveInv) saveInv();
      ctx.cfg.spoolman = { ...conf(), last: { at: Date.now(), ok: true, imported: out.imported, created: out.created, updated: out.updated, retired: out.retired, skipped: out.skipped.length } };
      ctx.saveConfig();
      ctx.hublog("info", "spoolman: imported " + out.imported + " spool" + (out.imported === 1 ? "" : "s") + " (" + out.created + " new, " + out.updated + " updated, " + out.skipped.length + " skipped)");
      res.json({ ok: true, ...out, ...view() });
    } catch (e) {
      const msg = String((e && e.message) || e);
      ctx.cfg.spoolman = { ...conf(), last: { at: Date.now(), ok: false, error: msg.slice(0, 200) } };
      ctx.saveConfig();
      ctx.hublog("warn", "spoolman: import failed - " + msg);
      res.status(502).json({ error: "Import failed: " + msg, ...view() });
    } finally { RUNNING = false; }
  });

  ctx.provide("spoolman.state", () => view());
}

module.exports = { register, mapSpool, normUrl };
