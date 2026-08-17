// rfid.js — RFID / spool-identity wrap-up for the U1 Print Hub (v2.9).
//
// What this is: hub-side tag scanning. An external device (the phone's browser
// via Web NFC today; a USB reader or QR label later) reads a tag's freely-
// readable UID and sends it here; the Hub binds it ONCE to a filament identity
// and remembers it. PRINTERS DO NOT READ TAGS for this feature — the U1's
// onboard reads happen inside Snapmaker firmware (we only ever receive
// CARD_UID via the API), Sovols have no RFID at all. The printer is strictly
// downstream: it prints gcode and never knows a tag was mapped.
//
// The UID is just the tag's serial — an anonymous number. Bare third-party
// spools carry no color/material payload we can decode (and we publicly
// committed NOT to decode proprietary payloads), so the binding is
// user-supplied once and remembered forever.
//
// ---- spool_id indirection (architecture-critical, deliberate) --------------
// The Hub's primary key is a generated `spool_id`, NOT the raw tag UID.
// Adapters resolve TO it:
//   * Web NFC / USB reader → tag UID → (TAGS map) → spool_id
//   * QR → encodes the spool_id directly on a label WE print
// The association engine below only ever sees spool_id. Binding straight to
// UID would fork QR onto a separate path; this indirection costs nothing now
// and would be painful to retrofit. All three input methods are architected
// here; ONLY Web NFC ships verified in 2.9 (USB + QR wait for their own
// hardware gates, per Rule #1).
//
// ---- Association source: FilamentColors.xyz (single source, settled) -------
// Bundled trimmed snapshot (filament-swatches.json, ~2,266 swatches, ~450 KB;
// see scripts/refresh-filament-db.js). MIT-licensed, colorimeter-MEASURED
// hex/LAB (CHNSpec DS-220) — feeds CIEDE2000 matching natively. Every record
// carries color_source:"measured"; user manual entries are tagged "user" so a
// future second DB ("nominal") could be down-weighted instead of silently
// corrupting the match math. Deliberately NOT merged with a second filament DB
// — long-tail coverage comes from the manual-entry fallback writing into the
// local color library instead.
//
// Refresh model (option b, settled): bundled-and-loadable offline, plus a
// manual "Update filament library" action that re-pulls the API and stores the
// result NEXT TO config.json (BASE_DIR copy beats the bundled one on load).
// No live per-scan calls, ever — hub runs on air-gapped farm LANs, and the
// maintainer explicitly asks integrators to cache. Attribution: credit
// FilamentColors.xyz visibly wherever a swatch is shown (the UI does).
//
// State (spools.json, next to config.json):
//   { spools: { spool_id: identity }, tags: { uid: spool_id }, local: [identity] }
// `local` is the user's local color library — manual entries saved for reuse
// so next time they're a search pick, not typing.

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function mountRfid(app, express, BASE_DIR, ASSET_DIR, helpers) {
  const SPOOLS_PATH = path.join(BASE_DIR, "spools.json");
  const SNAP_LOCAL = path.join(BASE_DIR, "filament-swatches.json");   // refreshed copy (wins)
  const SNAP_BUNDLED = path.join(ASSET_DIR, "filament-swatches.json"); // shipped in repo/pkg/Docker

  // ---- persistent state ----------------------------------------------------
  let STATE = { spools: {}, tags: {}, local: [] };
  function loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(SPOOLS_PATH, "utf8"));
      STATE = {
        spools: (s && typeof s.spools === "object" && s.spools) || {},
        tags: (s && typeof s.tags === "object" && s.tags) || {},
        local: Array.isArray(s && s.local) ? s.local : []
      };
    } catch { STATE = { spools: {}, tags: {}, local: [] }; }
  }
  function saveState() { try { fs.writeFileSync(SPOOLS_PATH, JSON.stringify(STATE, null, 2)); } catch {} }
  loadState();

  // ---- snapshot ------------------------------------------------------------
  let SNAP = { fetchedAt: null, count: 0, swatches: [] };
  let SNAP_FROM = null;
  function loadSnapshot() {
    for (const p of [SNAP_LOCAL, SNAP_BUNDLED]) {
      try {
        const s = JSON.parse(fs.readFileSync(p, "utf8"));
        if (Array.isArray(s.swatches)) { SNAP = s; SNAP_FROM = p; return; }
      } catch {}
    }
    SNAP = { fetchedAt: null, count: 0, swatches: [] }; SNAP_FROM = null;
  }
  loadSnapshot();

  // Normalize a tag UID: Web NFC serialNumber is colon-separated hex
  // ("04:a3:1c:..."); USB keyboard-wedge readers often emit bare hex. Same tag
  // must always resolve to the same key regardless of the adapter that read it.
  function normUid(uid) {
    const s = String(uid || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    return s.length >= 6 ? s : null; // shortest real UIDs are 4 bytes
  }

  const newSpoolId = () => "sp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Shape/sanitize a filament identity record. Everything optional except hex.
  // Multi-color filaments (silk duals/tris, gradients/rainbows) carry
  // `hexes` (2–3 colors, first one IS `hex` so every existing consumer —
  // Spool Match, setcolor push, recommender — keeps working off the primary)
  // plus `color_style`: "gradient" (smooth transition) or "multi" (hard
  // segments, coextruded look). Solid spools omit both.
  function cleanIdentity(x, source) {
    if (!x) return null;
    const hex1 = /^#?([0-9a-fA-F]{6})$/.exec(String(x.hex || ""));
    if (!hex1) return null;
    const lab = Array.isArray(x.lab) && x.lab.length === 3 && x.lab.every(v => typeof v === "number") ? x.lab : null;
    let hexes = null, style = null;
    if (Array.isArray(x.hexes)) {
      const clean = x.hexes.map(h => (/^#?([0-9a-fA-F]{6})$/.exec(String(h || "")) || [])[1]).filter(Boolean).map(h => h.toUpperCase()).slice(0, 3);
      if (clean.length >= 2) {
        clean[0] = hex1[1].toUpperCase();          // primary is authoritative
        hexes = clean;
        style = x.color_style === "gradient" ? "gradient" : "multi";
      }
    }
    return {
      brand: String(x.brand || "").slice(0, 80),
      material: String(x.material || "").slice(0, 40),
      material_variant: String(x.material_variant || "").slice(0, 40),
      color_name: String(x.color_name || "").slice(0, 80),
      hex: hex1[1].toUpperCase(),
      hexes,                                       // null for solids
      color_style: style,                          // null | "gradient" | "multi"
      lab,                                        // measured LAB feeds CIEDE2000 directly; null for user entries
      hot_end_temp: Number.isFinite(+x.hot_end_temp) ? +x.hot_end_temp : null,
      bed_temp: Number.isFinite(+x.bed_temp) ? +x.bed_temp : null,
      swatch_id: Number.isFinite(+x.swatch_id) ? +x.swatch_id : null,
      color_source: source || String(x.color_source || "user")
    };
  }

  // ---- search (mirrors the API's q + page_size over the local snapshot) ----
  // Text match across color_name, brand (manufacturer.name), and
  // material_variant (filament_type.name) — the same trio the live API's `q`
  // searches. Local-library entries are included, flagged by color_source.
  app.get("/api/filaments/search", (req, res) => {
    const q = String(req.query.q || req.query.f || "").trim().toLowerCase();
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 15));
    const hay = s => String(s || "").toLowerCase();
    const pool = SNAP.swatches.concat(STATE.local);
    const hits = !q ? pool.slice(0, pageSize) : [];
    if (q) {
      const words = q.split(/\s+/).filter(Boolean);
      for (const s of pool) {
        const text = hay(s.color_name) + " " + hay(s.brand) + " " + hay(s.material_variant) + " " + hay(s.material);
        if (words.every(w => text.includes(w))) {
          hits.push(s);
          if (hits.length >= pageSize) break;
        }
      }
    }
    res.json({ count: hits.length, results: hits, attribution: "Filament data © FilamentColors.xyz (MIT)" });
  });

  app.get("/api/filaments/meta", (req, res) => {
    res.json({
      count: SNAP.swatches.length,
      localCount: STATE.local.length,
      fetchedAt: SNAP.fetchedAt || null,
      source: "FilamentColors.xyz",
      license: "MIT",
      refreshed: SNAP_FROM === SNAP_LOCAL
    });
  });

  // Manual "Update filament library" (Settings button — refresh option b).
  // One deliberate action; the result lands next to config.json so the bundled
  // snapshot stays pristine and air-gapped installs simply keep the bundle.
  let REFRESHING = false;
  app.post("/api/filaments/refresh", async (req, res) => {
    if (REFRESHING) return res.status(409).json({ error: "A refresh is already running" });
    REFRESHING = true;
    try {
      const { pullAll } = require("./scripts/refresh-filament-db.js");
      const snap = await pullAll(null);
      fs.writeFileSync(SNAP_LOCAL, JSON.stringify(snap));
      loadSnapshot();
      res.json({ ok: true, count: snap.count, fetchedAt: snap.fetchedAt });
    } catch (e) {
      res.status(502).json({ error: "Could not reach FilamentColors.xyz — " + String(e.message || e) + ". The bundled library keeps working offline." });
    } finally { REFRESHING = false; }
  });

  // ---- spools --------------------------------------------------------------
  app.get("/api/spools", (req, res) => {
    const spools = Object.entries(STATE.spools).map(([id, ident]) => ({
      spool_id: id, ...ident,
      uids: Object.entries(STATE.tags).filter(([, sid]) => sid === id).map(([u]) => u)
    }));
    spools.sort((a, b) => (b.boundAt || 0) - (a.boundAt || 0));
    res.json({ spools });
  });

  // Resolve an identifier to a filament identity. Accepts either a tag `uid`
  // (NFC/USB adapters) or a `spool_id` (QR adapter — the label encodes it
  // directly). Unknown → { unknown:true } so the UI runs the one-time
  // association prompt.
  app.post("/api/spools/resolve", (req, res) => {
    const b = req.body || {};
    if (b.spool_id && STATE.spools[b.spool_id])
      return res.json({ known: true, spool_id: b.spool_id, spool: STATE.spools[b.spool_id] });
    const uid = normUid(b.uid);
    if (!uid) return res.status(400).json({ error: "Bad or missing tag UID" });
    const sid = STATE.tags[uid];
    if (sid && STATE.spools[sid])
      return res.json({ known: true, uid, spool_id: sid, spool: STATE.spools[sid] });
    res.json({ known: false, unknown: true, uid });
  });

  // Bind: create (or reuse) a spool identity and optionally attach a tag UID.
  // Three ways to supply the identity, mirroring the association flow:
  //   { swatch_id }  — picked from the snapshot search; one pick populates
  //                    brand + material_variant + hex + LAB + temps.
  //   { identity }   — manual entry (hex picker). saveLocal:true also writes it
  //                    into the local color library for next time.
  //   { sample: { printer, slot } } — bind to the color currently loaded in a
  //                    head (same print_task_config read path Spool Match uses).
  app.post("/api/spools/bind", async (req, res) => {
    const b = req.body || {};
    const uid = b.uid !== undefined ? normUid(b.uid) : null;
    if (b.uid !== undefined && !uid) return res.status(400).json({ error: "Bad tag UID" });

    let ident = null;
    try {
      if (b.swatch_id !== undefined) {
        const s = SNAP.swatches.concat(STATE.local).find(x => x.id === +b.swatch_id);
        if (!s) return res.status(404).json({ error: "Swatch " + b.swatch_id + " not found in the filament library" });
        ident = cleanIdentity({ ...s, swatch_id: s.id }, s.color_source || "measured");
      } else if (b.sample && b.sample.printer !== undefined) {
        const printers = (helpers && helpers.getPrinters) ? helpers.getPrinters() : [];
        const p = printers[b.sample.printer];
        const slot = parseInt(b.sample.slot, 10);
        if (!p) return res.status(400).json({ error: "Unknown printer" });
        if (!(slot >= 0 && slot <= 3)) return res.status(400).json({ error: "Slot must be 0–3" });
        const base = String(p.url).replace(/\/+$/, "");
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 3500);
        const r = await fetch(base + "/printer/objects/query?print_task_config", { signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) return res.status(502).json({ error: "Printer replied " + r.status });
        const ptc = ((((await r.json()).result || {}).status || {}).print_task_config) || {};
        if (!(ptc.filament_exist || [])[slot]) return res.status(409).json({ error: "No filament loaded in T" + (slot + 1) + " on " + p.name });
        const m = /^#?([0-9a-fA-F]{6})/.exec(String((ptc.filament_color_rgba || [])[slot] || ""));
        if (!m) return res.status(409).json({ error: "T" + (slot + 1) + " reports no color to sample" });
        ident = cleanIdentity({
          hex: m[1],
          material: (ptc.filament_type || [])[slot] || "",
          material_variant: ((ptc.filament_sub_type || [])[slot] && (ptc.filament_sub_type || [])[slot] !== "NONE") ? (ptc.filament_sub_type || [])[slot] : ((ptc.filament_type || [])[slot] || ""),
          color_name: b.color_name || ("Sampled from " + p.name + " T" + (slot + 1)),
          brand: b.brand || ""
        }, "sampled");
      } else if (b.identity) {
        ident = cleanIdentity(b.identity, "user");
        if (ident && b.saveLocal) {
          // Local color library: user additions become searchable picks, tagged
          // by a negative id namespace so they never collide with API ids.
          const localId = -(STATE.local.length + 1);
          STATE.local.push({ ...ident, id: localId });
        }
      }
    } catch (e) {
      return res.status(502).json({ error: String(e.message || e) });
    }
    if (!ident) {
      // No identity supplied but an existing spool_id given → ATTACH mode:
      // point this tag at the already-bound spool without touching its
      // identity. This is how a re-labelled spool (built-in vendor tag AND a
      // Hub NTAG sticker), or a tag whose serial reads differently on a
      // different adapter, avoids becoming a duplicate spool record.
      if (b.spool_id && STATE.spools[b.spool_id]) {
        if (!uid) return res.status(400).json({ error: "Attach needs a tag uid" });
        STATE.tags[uid] = b.spool_id;
        saveState();
        return res.json({ ok: true, attached: true, spool_id: b.spool_id, uid, spool: STATE.spools[b.spool_id] });
      }
      return res.status(400).json({ error: "Provide swatch_id, identity {hex,...}, or sample {printer, slot}" });
    }

    const sid = (b.spool_id && STATE.spools[b.spool_id]) ? b.spool_id : newSpoolId();
    ident.boundAt = Date.now();
    STATE.spools[sid] = ident;
    if (uid) STATE.tags[uid] = sid;
    saveState();
    res.json({ ok: true, spool_id: sid, uid: uid || null, spool: ident });
  });

  // Forget a spool (and any tag UIDs pointing at it), or detach a single UID.
  app.post("/api/spools/forget", (req, res) => {
    const b = req.body || {};
    if (b.uid) {
      const uid = normUid(b.uid);
      if (uid && STATE.tags[uid]) { delete STATE.tags[uid]; saveState(); return res.json({ ok: true, forgot: "tag" }); }
      return res.status(404).json({ error: "Tag not bound" });
    }
    const sid = String(b.spool_id || "");
    if (!STATE.spools[sid]) return res.status(404).json({ error: "Unknown spool" });
    delete STATE.spools[sid];
    for (const [uid, s] of Object.entries(STATE.tags)) if (s === sid) delete STATE.tags[uid];
    if (unassignSpool(sid)) saveSlots();   // a forgotten spool can't stay "loaded"
    saveState();
    res.json({ ok: true, forgot: "spool" });
  });

  // ---- Loadout: which spool is physically in which printer slot (v2.9) ------
  // Closes the scan→bind loop: after a tag identifies a spool, "Load to
  // printer" records WHERE it went. Pure Hub-side state (slots.json, next to
  // spools.json, gitignored) — the printer is never told anything by this
  // feature. Pushing the spool's color onto a U1 tray remains the existing,
  // hardware-verified /api/setcolor route; the UI chains it as an option.
  //
  // Keyed by printer URL, not array index: removing a printer from Settings
  // must not silently shift every other printer's loadout. A URL that leaves
  // the config keeps its entry (invisible until the printer returns).
  //
  // Invariant: one spool exists in at most one slot — filament is physical.
  // Assigning moves it; assigning into an occupied slot replaces the occupant.
  const SLOTS_PATH = path.join(BASE_DIR, "slots.json");
  let SLOTS = {};   // { "<printer url>": { "<slotIdx>": { spool_id, at } } }
  function loadSlots() {
    try {
      const s = JSON.parse(fs.readFileSync(SLOTS_PATH, "utf8"));
      SLOTS = (s && typeof s === "object" && !Array.isArray(s)) ? s : {};
    } catch { SLOTS = {}; }
  }
  function saveSlots() { try { fs.writeFileSync(SLOTS_PATH, JSON.stringify(SLOTS, null, 2)); } catch {} }
  function unassignSpool(sid) {
    let touched = false;
    for (const m of Object.values(SLOTS)) {
      for (const k of Object.keys(m)) if (m[k] && m[k].spool_id === sid) { delete m[k]; touched = true; }
    }
    return touched;
  }
  loadSlots();

  // Resolved view: only printers in the CURRENT config, identities attached.
  app.get("/api/slots", (req, res) => {
    const printers = (helpers && helpers.getPrinters) ? helpers.getPrinters() : [];
    const out = printers.map((p, i) => {
      const m = SLOTS[String(p.url)] || {};
      const slots = {};
      for (const [k, v] of Object.entries(m)) {
        if (!v || !STATE.spools[v.spool_id]) continue;   // stale entry — hide, don't invent
        slots[k] = { spool_id: v.spool_id, at: v.at, spool: STATE.spools[v.spool_id] };
      }
      return { printer: i, name: p.name, type: p.type || "u1", slots };
    });
    res.json({ printers: out });
  });

  app.post("/api/slots/assign", async (req, res) => {
    const b = req.body || {};
    const printers = (helpers && helpers.getPrinters) ? helpers.getPrinters() : [];
    const p = printers[b.printer];
    if (!p) return res.status(400).json({ error: "Unknown printer" });
    const sid = String(b.spool_id || "");
    if (!STATE.spools[sid]) return res.status(404).json({ error: "Unknown spool — bind it first" });
    const slot = parseInt(b.slot, 10);
    if (!(slot >= 0 && slot <= 3)) return res.status(400).json({ error: "Slot must be 0–3" });
    // Range-check against DETECTED capabilities when we have them; while caps
    // are unknown (printer offline) stay lenient — recording where filament
    // physically went must not depend on the printer being reachable.
    try {
      const caps = (helpers && helpers.getCaps) ? await helpers.getCaps(Number(b.printer)) : null;
      if (caps && slot >= caps.heads)
        return res.status(400).json({ error: p.name + " reports " + caps.heads + " slot" + (caps.heads === 1 ? "" : "s") + " — T" + (slot + 1) + " doesn't exist on it" });
    } catch {}
    const key = String(p.url);
    const prev = (SLOTS[key] || {})[slot];
    const replaced = prev && prev.spool_id !== sid && STATE.spools[prev.spool_id]
      ? { spool_id: prev.spool_id, spool: STATE.spools[prev.spool_id] } : null;
    unassignSpool(sid);                                   // physical move: one location only
    (SLOTS[key] = SLOTS[key] || {})[slot] = { spool_id: sid, at: Date.now() };
    saveSlots();
    if (helpers && helpers.log) helpers.log("info", "loadout: " + (STATE.spools[sid].color_name || "#" + STATE.spools[sid].hex) + " → " + p.name + " T" + (slot + 1) + (replaced ? " (replaced " + (replaced.spool.color_name || "#" + replaced.spool.hex) + ")" : ""));
    res.json({ ok: true, printer: Number(b.printer), slot, spool_id: sid, spool: STATE.spools[sid], replaced });
  });

  app.post("/api/slots/clear", (req, res) => {
    const b = req.body || {};
    const printers = (helpers && helpers.getPrinters) ? helpers.getPrinters() : [];
    if (b.spool_id !== undefined) {                        // unload wherever it is
      const touched = unassignSpool(String(b.spool_id));
      if (touched) saveSlots();
      return touched ? res.json({ ok: true }) : res.status(404).json({ error: "That spool isn't loaded anywhere" });
    }
    const p = printers[b.printer];
    if (!p) return res.status(400).json({ error: "Unknown printer" });
    const slot = parseInt(b.slot, 10);
    const m = SLOTS[String(p.url)] || {};
    if (!m[slot]) return res.status(404).json({ error: "Nothing recorded in that slot" });
    delete m[slot];
    saveSlots();
    res.json({ ok: true });
  });
};
