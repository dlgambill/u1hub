// modules/notify.js — push notifications through ntfy (v2.24).
//
// "Tell my phone when a print finishes or a printer pauses" is the most asked
// for thing the Hub did not do. ntfy (ntfy.sh, or a self-hosted server) is the
// right shape for it: a POST to a URL, no account needed for the public
// server, an app on every phone, and nothing for the Hub to store about the
// person beyond a topic name they chose.
//
// What gets sent comes from core/events.js — the Hub already computes the
// edges (done / paused / error / offline / back online) once, for everyone.
// This module picks which of them the person wants and formats a message:
// the printer's name, the file, and for a pause the firmware's reason, which
// is the whole point of the v2.23 pause-reason work reaching a phone.
//
// Rules: OFF means no request is made at all. A topic is required — the Hub
// will not post to the root of a server. Failures are recorded, shown in the
// Settings card, and never retried in a loop: a notification that could not be
// delivered is not worth a second attempt thirty seconds later when the
// person is already looking at the printer.

"use strict";

const DEFAULTS = Object.freeze({
  enabled: false,
  url: "https://ntfy.sh",
  topic: "",
  token: "",
  events: { done: true, paused: true, error: true, offline: true, online: false, started: false, cancelled: false }
});
const TIMEOUT_MS = 8000;

function normUrl(u) {
  let x;
  try { x = new URL(String(u || "").trim()); } catch { return null; }
  if (x.protocol !== "http:" && x.protocol !== "https:") return null;
  return x.origin + x.pathname.replace(/\/+$/, "");
}

// ntfy topic rules: letters, digits, _ and - up to 64 chars.
const topicOk = t => /^[A-Za-z0-9_-]{1,64}$/.test(String(t || ""));

const fmtDur = s => {
  s = Math.round(Number(s) || 0);
  if (s < 60) return s + " s";
  const m = Math.round(s / 60); if (m < 60) return m + " min";
  const h = Math.floor(m / 60); return h + " h " + (m % 60) + " min";
};

// Event -> { title, body, priority, tags } or null when this event is off.
function compose(ev, on) {
  const file = ev.filename ? ev.filename.replace(/\.gcode$/i, "") : "";
  switch (ev.type) {
    case "print.done": return on.done && {
      title: ev.printer + " finished", body: (file || "the print") + (ev.durationSec ? " · " + fmtDur(ev.durationSec) : ""),
      priority: 3, tags: "white_check_mark" };
    case "print.paused": return on.paused && {
      title: ev.printer + " paused" + (ev.reason ? ": " + ev.reason : ""), body: ev.reason ? (file || "") : (file ? file + " · manual pause or filament change" : "manual pause or filament change"),
      priority: ev.reason ? 4 : 3, tags: ev.reason ? "warning" : "pause_button" };
    case "print.error": return on.error && {
      title: ev.printer + " error" + (ev.reason ? ": " + ev.reason : ""), body: file || "", priority: 5, tags: "rotating_light" };
    case "print.cancelled": return on.cancelled && {
      title: ev.printer + " print cancelled", body: file || "", priority: 3, tags: "no_entry_sign" };
    case "print.started": return on.started && {
      title: ev.printer + " started", body: file || "", priority: 2, tags: "arrow_forward" };
    case "printer.offline": return on.offline && {
      title: ev.printer + " is unreachable", body: "No answer for " + fmtDur((Date.now() - (ev.sinceMs || Date.now())) / 1000) + ". Powered off, or the network dropped.",
      priority: 4, tags: "electric_plug" };
    case "printer.online": return on.online && {
      title: ev.printer + " is back", body: "Reachable again.", priority: 2, tags: "electric_plug" };
  }
  return null;
}

function register(ctx) {
  const conf = () => {
    const c = (ctx.cfg && typeof ctx.cfg.notify === "object" && ctx.cfg.notify) || {};
    return {
      enabled: c.enabled === true,
      url: normUrl(c.url) || DEFAULTS.url,
      topic: topicOk(c.topic) ? String(c.topic) : "",
      token: typeof c.token === "string" ? c.token : "",
      events: { ...DEFAULTS.events, ...((c.events && typeof c.events === "object") ? c.events : {}) }
    };
  };

  const S = { sent: 0, failed: 0, last_sent: 0, last_error: null, last_title: null };

  // The only outbound call. Never throws.
  async function send(msg, override) {
    const c = { ...conf(), ...(override || {}) };
    if (!c.topic) return { ok: false, error: "no topic set" };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      // ntfy's JSON publish form: everything in the body, so a title with a
      // non-ASCII character (a printer called "Büro", a firmware message with
      // a dash) never has to squeeze through an HTTP header.
      const title = String(msg.title || "U1 Print Hub").replace(/[\r\n]+/g, " ").slice(0, 200);
      const payload = { topic: c.topic, title, message: String(msg.body || "") || title, priority: Number(msg.priority) || 3 };
      if (msg.tags) payload.tags = String(msg.tags).split(",").map(s => s.trim()).filter(Boolean);
      const headers = { "Content-Type": "application/json" };
      if (c.token) headers.Authorization = "Bearer " + c.token;
      const r = await fetch(c.url, { method: "POST", headers, body: JSON.stringify(payload), signal: ac.signal });
      if (!r.ok) throw new Error("HTTP " + r.status + " from " + c.url);
      S.sent++; S.last_sent = Date.now(); S.last_error = null; S.last_title = title;
      return { ok: true };
    } catch (e) {
      S.failed++;
      S.last_error = (e && e.name === "AbortError") ? "ntfy did not answer within " + (TIMEOUT_MS / 1000) + " s" : String((e && e.message) || e).slice(0, 160);
      ctx.hublog("info", "notify: send failed - " + S.last_error);
      return { ok: false, error: S.last_error };
    } finally { clearTimeout(t); }
  }

  function view() {
    const c = conf();
    return { enabled: c.enabled, url: c.url, topic: c.topic, token_set: !!c.token, events: c.events,
      ready: !!(c.enabled && c.topic), stats: { ...S } };
  }

  // Subscribe to every fleet edge; compose() decides what is wanted.
  if (ctx.events) {
    ctx.events.on("*", ev => {
      const c = conf();
      if (!c.enabled || !c.topic) return;
      const msg = compose(ev, c.events);
      if (msg) send(msg).catch(() => {});
    });
  }

  ctx.app.get("/api/notify", (req, res) => res.json(view()));

  ctx.app.post("/api/notify/settings", (req, res) => {
    const b = req.body || {};
    const cur = (ctx.cfg.notify && typeof ctx.cfg.notify === "object") ? ctx.cfg.notify : {};
    const next = { ...cur };
    if ("url" in b) {
      const u = String(b.url || "").trim();
      if (u) { const n = normUrl(u); if (!n) return res.status(400).json({ error: "ntfy server must be an http(s) URL" }); next.url = n; }
      else delete next.url;
    }
    if ("topic" in b) {
      const tp = String(b.topic || "").trim();
      if (tp && !topicOk(tp)) return res.status(400).json({ error: "topic: letters, digits, - and _ only (up to 64)" });
      next.topic = tp;
    }
    if ("token" in b) next.token = String(b.token || "");
    if ("events" in b && b.events && typeof b.events === "object") {
      next.events = { ...DEFAULTS.events, ...(cur.events || {}) };
      for (const k of Object.keys(DEFAULTS.events)) if (k in b.events) next.events[k] = !!b.events[k];
    }
    if ("enabled" in b) {
      if (b.enabled && !(next.topic || "")) return res.status(400).json({ error: "Set a topic before turning notifications on" });
      next.enabled = !!b.enabled;
    }
    ctx.cfg.notify = next;
    ctx.saveConfig();
    res.json(view());
  });

  // Explicit test from Settings: uses the values in the form (body) so a
  // person can check before saving. Does not require enabled.
  ctx.app.post("/api/notify/test", async (req, res) => {
    const b = req.body || {};
    const o = {};
    if (b.url) { const n = normUrl(b.url); if (!n) return res.status(400).json({ error: "ntfy server must be an http(s) URL" }); o.url = n; }
    if ("topic" in b) { if (!topicOk(b.topic)) return res.status(400).json({ error: "topic: letters, digits, - and _ only" }); o.topic = String(b.topic); }
    if ("token" in b) o.token = String(b.token || "");
    const r = await send({ title: "U1 Print Hub", body: "Test notification. If you can read this, the Hub can reach your phone.", priority: 3, tags: "tada" }, o);
    res.status(r.ok ? 200 : 502).json({ ...r, ...view() });
  });

  // For other modules (Dispatch could announce a missed deadline, say).
  ctx.provide("notify.send", (msg) => send(msg));
  ctx.provide("notify.state", () => view());
}

module.exports = { register, compose, normUrl, topicOk, DEFAULTS };
