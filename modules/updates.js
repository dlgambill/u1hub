// modules/updates.js — "there's a newer Hub than the one you're running."
//
// Deliberately NOT the same thing as the #vbadge in index.html. That badge
// compares the page the browser loaded against the server process answering it
// — it catches a stale tab or a server you edited but didn't restart, and it is
// entirely local. This module answers a different question: is there a newer
// release upstream than the version installed here.
//
// Design constraints, in the order that shaped the code:
//
//   1. Most installs are on a LAN, and some have no route to the internet at
//      all. A failed check is the NORMAL case, not an error case. It must never
//      block a request, never surface a red banner, and never retry in a way
//      that costs anything. Offline looks exactly like "no update known".
//   2. The check is a plain GET of a static JSON file. No version, no install
//      id, no query string, no headers beyond what fetch sends by default —
//      Danny gets no telemetry out of this and users are told so. If that ever
//      changes it stops being a version check and becomes analytics, which is a
//      different feature with a different consent conversation.
//   3. It is one checkbox to turn off, and off means no outbound request is
//      made at all — not "made and discarded".
//   4. Version comparison is numeric per component. String comparison says
//      "2.9.0" > "2.17.0" and would tell every user on the newest build that
//      they are behind. See cmpVersion() and the harness table.

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  enabled: true,
  url: "https://raw.githubusercontent.com/dlgambill/u1hub/main/update.json",
  interval_hours: 24
});

const TIMEOUT_MS = 6000;      // a LAN with no route usually fails faster
const MIN_INTERVAL_H = 1;     // floor, so a bad config cannot poll in a loop
const MAX_NOTES = 400;

// A manifest URL must be https, with one carve-out: plain http to an address
// that cannot leave the building. An air-gapped farm that mirrors releases
// internally has nowhere to get a certificate from, and forcing https there
// would mean the feature simply cannot be used by the installs most likely to
// want a local mirror. Anything routable on the public internet stays https.
function urlOk(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.protocol === "https:") return true;
  if (x.protocol !== "http:") return false;
  const h = x.hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// Numeric semver-ish comparison. Returns -1 / 0 / 1 for a<b / a==b / a>b.
// Only the release core is ordered numerically; a prerelease tag sorts before
// the same core ("2.18.0-rc1" < "2.18.0"), which is the semver rule and also
// the intuitive one — an rc is not the release.
function cmpVersion(a, b) {
  const core = v => String(v == null ? "" : v).trim().replace(/^v/i, "").split("-")[0];
  const nums = v => core(v).split(".").map(n => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  const A = nums(a), B = nums(b);
  for (let i = 0; i < 3; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pre = v => String(v == null ? "" : v).trim().split("-").slice(1).join("-");
  const pa = pre(a), pb = pre(b);
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return 0;
}

function register(ctx) {
  // NOT "updates.json": the published manifest at the repo root is update.json,
  // and two state-vs-manifest files one letter apart is how the wrong one ends
  // up committed. This is the local cache; update.json is the thing users fetch.
  const FILE = path.join(ctx.baseDir, "update-state.json");
  const CURRENT = String(ctx.version || "0.0.0");

  // Persisted so a restart neither loses a dismissal nor re-checks immediately.
  let S = {
    last_check: 0,      // epoch ms of the last COMPLETED attempt, ok or not
    last_ok: 0,         // epoch ms of the last attempt that actually parsed
    latest: null,       // version string from the manifest
    notes: null,
    link: null,
    dismissed: null,    // version the user has already been told about
    last_error: null    // short reason, for Settings — never shown as an alarm
  };
  try { S = Object.assign(S, JSON.parse(fs.readFileSync(FILE, "utf8")) || {}); } catch {}

  // X: (SMB) silently refuses rename-over-existing, so the textbook atomic
  // write loses every save. Same latched fallback as modules/dispatch.js —
  // see MISTAKES.md 2026-09-01.
  let SAVE_FALLBACK = false;
  function save() {
    const data = JSON.stringify(S, null, 2);
    const tmp = FILE + ".tmp";
    if (!SAVE_FALLBACK) {
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, FILE); return; }
      catch (e) {
        SAVE_FALLBACK = true;
        ctx.hublog("warn", "updates: atomic save failed (" + e.code + ") — falling back to direct write");
      }
    }
    fs.writeFileSync(FILE, data);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }

  function conf() {
    const c = (ctx.cfg && typeof ctx.cfg.updates === "object" && ctx.cfg.updates) || {};
    const hours = Number(c.interval_hours);
    return {
      enabled: c.enabled !== false,
      url: typeof c.url === "string" && c.url.trim() ? c.url.trim() : DEFAULTS.url,
      interval_hours: Number.isFinite(hours) && hours >= MIN_INTERVAL_H ? hours : DEFAULTS.interval_hours
    };
  }

  const stale = () => Date.now() - S.last_check > conf().interval_hours * 3600e3;

  // The only outbound call in this module. Resolves to true/false; never throws,
  // never rejects, and is a no-op when the feature is switched off.
  async function check(reason) {
    const c = conf();
    if (!c.enabled) return false;                 // off means no request at all
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      // Plain GET of a static file. No query string, no install identifier:
      // whatever is learned upstream is an IP hitting a public URL, the same as
      // any page view, and nothing that ties it to this Hub.
      const r = await fetch(c.url, { signal: ac.signal, redirect: "follow" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const m = await r.json();
      const v = m && typeof m.version === "string" ? m.version.trim() : "";
      if (!v) throw new Error("manifest has no version");
      S.latest = v;
      S.notes = typeof m.notes === "string" ? m.notes.slice(0, MAX_NOTES) : null;
      S.link = typeof m.url === "string" ? m.url : null;
      S.last_ok = Date.now();
      S.last_error = null;
      ctx.hublog("info", "updates: manifest says " + v + " (running " + CURRENT + ", " + reason + ")");
      return true;
    } catch (e) {
      // Offline is the expected state on an isolated LAN. Record it quietly at
      // info, not warn: a farm with no internet should not accumulate warnings
      // it can do nothing about.
      S.last_error = (e && e.name === "AbortError") ? "timed out" : String((e && e.message) || e).slice(0, 120);
      ctx.hublog("info", "updates: check skipped — " + S.last_error);
      return false;
    } finally {
      clearTimeout(timer);
      S.last_check = Date.now();
      try { save(); } catch {}
    }
  }

  function view() {
    const c = conf();
    const newer = !!(c.enabled && S.latest && cmpVersion(CURRENT, S.latest) < 0);
    return {
      current: CURRENT,
      latest: S.latest,
      newer,
      // The UI shows a notice only for a version the user has not waved away.
      notify: newer && S.dismissed !== S.latest,
      notes: S.notes,
      link: S.link,
      dismissed: S.dismissed,
      enabled: c.enabled,
      url: c.url,
      interval_hours: c.interval_hours,
      last_check: S.last_check || null,
      last_ok: S.last_ok || null,
      last_error: S.last_error
    };
  }

  // --- routes --------------------------------------------------------------
  // GET never awaits the network. If the cache is stale it kicks a check off
  // and answers from what it already has; the next poll picks up the result.
  // A dashboard that hangs because GitHub is slow is a worse bug than a version
  // notice that appears thirty seconds late.
  ctx.app.get("/api/updates", (req, res) => {
    if (conf().enabled && stale()) check("stale cache").catch(() => {});
    res.json(view());
  });

  // Explicit user action, so this one waits for the answer.
  ctx.app.post("/api/updates/check", async (req, res) => {
    if (!conf().enabled) return res.status(409).json({ error: "update checks are turned off" });
    await check("manual");
    res.json(view());
  });

  ctx.app.post("/api/updates/dismiss", (req, res) => {
    const v = req.body && typeof req.body.version === "string" ? req.body.version.trim() : "";
    if (!v) return res.status(400).json({ error: "version required" });
    S.dismissed = v; save();
    res.json(view());
  });

  ctx.app.post("/api/updates/settings", (req, res) => {
    const b = req.body || {};
    const cur = (ctx.cfg.updates && typeof ctx.cfg.updates === "object") ? ctx.cfg.updates : {};
    const next = { ...DEFAULTS, ...cur };
    if ("enabled" in b) next.enabled = b.enabled !== false;
    if ("interval_hours" in b) {
      const h = Number(b.interval_hours);
      if (!Number.isFinite(h) || h < MIN_INTERVAL_H) return res.status(400).json({ error: "interval_hours must be >= " + MIN_INTERVAL_H });
      next.interval_hours = h;
    }
    if ("url" in b) {
      const u = String(b.url || "").trim();
      if (u && !urlOk(u)) return res.status(400).json({ error: "manifest url must be https, or http to a private address" });
      next.url = u || DEFAULTS.url;
    }
    ctx.cfg.updates = next;
    ctx.saveConfig();
    res.json(view());
  });

  // One check shortly after boot, so a Hub left running for weeks still learns
  // about a release. unref() so it never holds the process open.
  if (conf().enabled) {
    const t = setTimeout(() => { if (stale()) check("startup").catch(() => {}); }, 30000);
    if (t.unref) t.unref();
  }

  ctx.provide("updates.state", () => view());
}

// cmpVersion is exported so the harness can drive the ordering table directly
// rather than inferring it from an HTTP response.
module.exports = { register, cmpVersion, urlOk, DEFAULTS };

