// modules/power.js — smart power control (v2.11 module; code moved verbatim
// from server.js where it shipped in 2.8/2.10, hardware-verified on a Shelly
// Plug US Gen4). Behavior is identical to 2.10 when the module is enabled
// (the default); with features.power=false the routes don't exist and the
// fleet stops advertising plug metadata.
//
// Module contract: export register(ctx). ctx.printers is a LIVE getter (the
// printer array is reassigned on every config save — never capture it).

"use strict";

function register(ctx) {
  // ---- Smart power control: switch a printer's plug on/off + read draw -------
  // Each printer MAY carry a typed `plug` descriptor in config.json:
  //   "plug": { "type":"shelly", "ip":"192.168.12.235" }                  // metered on/off
  //   "plug": { "type":"url", "on":"http://x/on", "off":"http://x/off" }  // any local-HTTP plug, on/off only
  // Hardware-verified on a Shelly Plug US Gen4 (model S4PL-00116US, gen 4):
  //   GET /rpc/Shelly.GetDeviceInfo  -> reachable, auth-optional (auth_en:false)
  //   GET /rpc/Switch.GetStatus?id=0 -> { output, apower, voltage, aenergy:{total}, temperature:{tC} }
  //   GET /rpc/Switch.Set?id=0&on=<bool> -> { was_on }
  // The `shelly` driver reads live draw + energy; the generic `url` driver just
  // fires the configured on/off URL (covers Tasmota, ESPHome, HA webhooks, DIY
  // ESP32 — anything with a local HTTP endpoint) with no metering.
  // SAFETY: turning a plug OFF is hard-blocked while its printer is printing or
  // paused — a live print_stats query gates every off (same pattern as the file-
  // management active-print guard). If we can't confirm the printer is idle, the
  // off is refused (fail safe). Turning ON is always allowed. NOTE: this guard
  // only covers the Hub's own Off button — the physical button, the Shelly app,
  // and power outages are outside the Hub's reach.

  async function plugRead(plug) {
    if (!plug || !plug.type) throw new Error("no plug configured");
    if (plug.type === "shelly") {
      const ip = String(plug.ip || "").trim();
      if (!ip) throw new Error("shelly plug missing 'ip'");
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch("http://" + ip + "/rpc/Switch.GetStatus?id=0", { signal: ctrl.signal });
        if (!r.ok) throw new Error("plug HTTP " + r.status);
        const s = await r.json();
        const ae = s.aenergy || {};
        const t = s.temperature || {};
        return {
          on: !!s.output,
          watts: typeof s.apower === "number" ? s.apower : null,
          volts: typeof s.voltage === "number" ? s.voltage : null,
          energyWh: typeof ae.total === "number" ? ae.total : null,
          tempC: typeof t.tC === "number" ? t.tC : null,
          metered: true
        };
      } finally { clearTimeout(to); }
    }
    if (plug.type === "url") {
      // generic plug: on/off only, no reliable status read
      return { on: null, watts: null, volts: null, energyWh: null, tempC: null, metered: false };
    }
    throw new Error("unknown plug type '" + plug.type + "'");
  }

  async function plugSet(plug, on) {
    if (!plug || !plug.type) throw new Error("no plug configured");
    if (plug.type === "shelly") {
      const ip = String(plug.ip || "").trim();
      if (!ip) throw new Error("shelly plug missing 'ip'");
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch("http://" + ip + "/rpc/Switch.Set?id=0&on=" + (on ? "true" : "false"), { signal: ctrl.signal });
        if (!r.ok) throw new Error("plug HTTP " + r.status);
        await r.json().catch(() => ({}));
      } finally { clearTimeout(to); }
      return;
    }
    if (plug.type === "url") {
      const target = on ? plug.on : plug.off;
      if (!target) throw new Error("url plug missing '" + (on ? "on" : "off") + "' endpoint");
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(String(target), { signal: ctrl.signal });
        if (!r.ok) throw new Error("plug HTTP " + r.status);
      } finally { clearTimeout(to); }
      return;
    }
    throw new Error("unknown plug type '" + plug.type + "'");
  }

  // Live print state for the off-guard (mirrors the file-management guard helper).
  async function plugGuardState(base) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(base + "/printer/objects/query?print_stats", { signal: ctrl.signal });
      if (!r.ok) throw new Error("Moonraker " + r.status);
      const ps = ((((await r.json()).result) || {}).status || {}).print_stats || {};
      return ps.state || "unknown";
    } finally { clearTimeout(to); }
  }

  ctx.app.get("/api/power", async (req, res) => {
    const p = ctx.printers[req.query.id];
    if (!p) return res.status(400).json({ error: "Unknown printer" });
    if (!p.plug) return res.status(404).json({ error: "No plug configured for " + (p.name || "printer") });
    try {
      const st = await plugRead(p.plug);
      res.json({ id: Number(req.query.id), type: p.plug.type, ...st });
    } catch (e) {
      res.status(502).json({ error: "Plug unreachable: " + e.message });
    }
  });

  ctx.app.post("/api/power", async (req, res) => {
    const b = req.body || {};
    const p = ctx.printers[b.id];
    if (!p) return res.status(400).json({ error: "Unknown printer" });
    if (!p.plug) return res.status(404).json({ error: "No plug configured for " + (p.name || "printer") });
    if (typeof b.on !== "boolean") return res.status(400).json({ error: "Body needs { id, on: true|false }" });
    // SAFETY: never cut power to a printer that is printing or paused.
    if (b.on === false) {
      const base = String(p.url).replace(/\/+$/, "");
      let state;
      try { state = await plugGuardState(base); }
      catch (e) { return res.status(502).json({ error: "Can't confirm " + p.name + " is idle (" + e.message + ") — refusing to power off." }); }
      if (state === "printing" || state === "paused")
        return res.status(409).json({ error: "REFUSED: " + p.name + " is " + state + " — the Hub won't cut power mid-print." });
    }
    try {
      await plugSet(p.plug, b.on);
      let st = null;
      try { st = await plugRead(p.plug); } catch {}
      res.json({ ok: true, id: Number(b.id), on: b.on, type: p.plug.type, ...(st || {}) });
    } catch (e) {
      res.status(502).json({ error: "Plug command failed: " + e.message });
    }
  });

}

module.exports = { register };
