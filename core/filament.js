// core/filament.js — filament color + material write (hardware-verified gcode)
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.

module.exports = function (hub) {
const { app, decodeHeads } = hub;


// ---- Filament color: set a slot's color from the Hub -----------------------
// Verified live 2026-07-03: the touchscreen itself issues this exact gcode
// (captured in /server/gcode_store when a color was changed on-screen):
//   SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER='3' FILAMENT_COLOR_RGBA='39FF14FF' SAVE='1'
// The Hub replays it via /printer/gcode/script, then reads print_task_config
// back and only reports success once the printer confirms the new color.
// Guards match touchscreen behavior: idle printers only, loaded slots only.
//
// v2.22.1 (Danny, field-found 2026-09-02): the head's MATERIAL too. Loading a
// spool pushed its color, so the Dash showed the right swatch on U6 T2 — and
// "NONE" for the type, because nothing ever wrote print_task_config's
// filament_type. A head with no type is what the touchscreen treats as not
// loaded, so the spool "didn't register" on the machine. The type now rides
// along as an optional `material` (+ `material_variant`), sent as its OWN
// command after the color so the color path stays byte-for-byte what was
// verified, and confirmed by the same read-back: if the firmware ignores the
// parameter, the Hub says the material did not take rather than pretending.
//
// v2.22.2 — HARDWARE-VERIFIED on U6, 2026-09-02 23:26, read from the printer's
// own /server/gcode_store after Danny picked PLA on the touchscreen:
//   SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=1 VENDOR=Snapmaker FILAMENT_TYPE=PLA FILAMENT_SUBTYPE='Basic'
// The first cut (2.22.1) sent FILAMENT_TYPE + FILAMENT_SUB_TYPE + SAVE and the
// firmware raised "[print_task_config] filament_config, incomplete parameters"
// as a System Anomaly on the touchscreen: VENDOR is REQUIRED, the sub-type
// parameter is FILAMENT_SUBTYPE (no underscore), and there is no SAVE. The
// command below is that capture, verbatim in shape. VENDOR=Snapmaker and
// FILAMENT_SUBTYPE='Basic' are the values the firmware is proven to accept;
// the spool's real brand/variant stay the truth in the Hub's own records.
// Only base types Snapmaker's firmware is known to list are ever sent —
// anything else is left for the touchscreen rather than risk another anomaly.
const BASE_TYPES = ["PETG", "PLA", "ABS", "ASA", "TPU", "PVA", "PA", "PC"]; // longest first: PETG before PLA/PA

function splitMaterial(material, variant) {
  const m = String(material || "").trim(), v = String(variant || "").trim();
  const hay = (m + " " + v).toUpperCase();
  const base = BASE_TYPES.find(t => new RegExp("(^|[^A-Z])" + t + "([^A-Z]|$)").test(hay)) || null;
  // "PLA+" typed as the material with no variant: the base is PLA and the
  // "+" is the sub-type, the way the touchscreen splits it.
  let sub = v;
  if (!sub && base && m && m.toUpperCase() !== base) sub = m;
  return { base, sub: sub.slice(0, 40) };
}

app.post("/api/setcolor", async (req, res) => {
  const { printer, slot, hex, material, material_variant } = req.body || {};
  const p = hub.PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const s = parseInt(slot, 10);
  if (!(s >= 0 && s <= 3)) return res.status(400).json({ error: "Slot must be 0–3" });
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) return res.status(400).json({ error: "Color must be RRGGBB hex" });
  const rgba = m[1].toUpperCase() + "FF";
  const base = String(p.url).replace(/\/+$/, "");
  try {
    let r = await fetch(base + "/printer/objects/query?print_stats&print_task_config");
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status });
    const st = (((await r.json()).result || {}).status) || {};
    const state = (st.print_stats || {}).state || "unknown";
    if (state === "printing" || state === "paused")
      return res.status(409).json({ error: "Printer is " + state + " — colors can only be changed while idle" });
    const exist = ((st.print_task_config || {}).filament_exist) || [];
    if (!exist[s]) return res.status(409).json({ error: "No filament loaded in slot T" + (s + 1) });
    // Official RFID spools are color-locked: firmware rejects the write with
    // "official filament, not configurable!" (hardware-confirmed 2026-07-09).
    // filament_edit is the authoritative writability flag — fail friendly here
    // instead of surfacing a Moonraker traceback.
    const editArr = ((st.print_task_config || {}).filament_edit) || [];
    if (editArr[s] === false)
      return res.status(409).json({ error: "T" + (s + 1) + " is an official Snapmaker RFID spool — its color comes from the tag and can't be changed" });

    // v2.22.2: the material FIRST, as its own command in the touchscreen's
    // exact verified shape (see BASE_TYPES above), then the color — so the
    // color is always the last word on the head, and a material refusal can
    // never undo it. Skipped entirely when the caller sent no material or one
    // the firmware has no base type for.
    let matInfo = null;
    const matGiven = String(material || "").trim() || String(material_variant || "").trim();
    if (matGiven) {
      const { base: mat, sub } = splitMaterial(material, material_variant);
      if (!mat) {
        matInfo = { sent: null, sub: sub || null, confirmed: false,
                    reason: "no printer base type in '" + String(material || material_variant || "") + "'" };
      } else {
        const tScript = `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=${s} VENDOR=Snapmaker FILAMENT_TYPE=${mat} FILAMENT_SUBTYPE='Basic'`;
        const tr = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(tScript), { method: "POST" });
        matInfo = { sent: mat, sub: sub || null, confirmed: false,
                    reason: tr.ok ? undefined : "Moonraker " + tr.status + ": " + (await tr.text()).slice(0, 120) };
      }
    }

    const script = `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER='${s}' FILAMENT_COLOR_RGBA='${rgba}' SAVE='1'`;
    r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(script), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });

    // Read back — success means the printer itself reports the new color.
    r = await fetch(base + "/printer/objects/query?print_task_config");
    if (!r.ok) return res.status(502).json({ error: "Write sent but read-back failed: Moonraker " + r.status });
    const ptc = ((((await r.json()).result || {}).status || {}).print_task_config) || {};
    const got = (ptc.filament_color_rgba || [])[s];
    if (String(got || "").toUpperCase() !== rgba)
      return res.status(502).json({ error: "Write not confirmed — printer reports " + (got || "nothing") });
    // The material is confirmed by the same rule: the printer has to say it.
    let warning;
    if (matInfo) {
      const gotT = String((ptc.filament_type || [])[s] || "").toUpperCase();
      matInfo.printer_reports = gotT || "nothing";
      matInfo.confirmed = !!matInfo.sent && gotT === matInfo.sent;
      if (!matInfo.confirmed)
        warning = matInfo.sent
          ? "Color set, but the printer did not take the material (" + matInfo.sent + ") — it still reports " +
            matInfo.printer_reports + ". Set the material on the touchscreen."
          : "Color set, but '" + String(material || material_variant || "") + "' isn't a material this printer knows — set it on the touchscreen.";
    }
    res.json({ ok: true, slot: s, hex: "#" + m[1].toUpperCase(), material: matInfo || undefined,
               warning, heads: decodeHeads(ptc) });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});
};
