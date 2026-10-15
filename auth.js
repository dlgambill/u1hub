// auth.js — single shared password gate for the U1 Print Hub.
//
// Design: one password for the whole Hub (it's a farm dashboard, not a
// multi-user app), stateless HMAC-signed cookie sessions (30 days), and an
// explicit off-switch for people who already run auth at their reverse proxy.
// No new npm dependencies: hashing is Node's built-in scrypt, sessions are
// HMAC-SHA256 — pkg builds are unchanged.
//
// Modes (persisted in auth.json next to config.json):
//   "open"     — no gate. This is the default until the user sets a password,
//                so upgrading an existing install never locks anyone out.
//   "password" — the gate: valid session cookie or you get the login page
//                (JSON 401 for /api/* so fetches fail loudly, 302 for pages).
//   "proxy"    — gate off, on purpose, documented: your reverse proxy is
//                doing auth. Distinct from "open" so the UI can say so.
//   "forward"  — forward-auth (Authelia/Authentik): requests must arrive with
//                the trusted identity header the proxy injects (default
//                Remote-User). Direct hits that bypass the proxy have no
//                header and are refused. The Hub's own login is bypassed —
//                the proxy already authenticated the person.
//
// auth.json: { mode, salt, hash, secret, header, trusted_proxies, ver }
// (salt/hash only in password mode; secret signs session cookies and is
// created on first setup; trusted_proxies is the forward-mode allowlist,
// loopback when absent; ver is bumped by every auth settings change).
// Kept OUT of config.json deliberately — /api/config echoes config to the
// settings UI and must never carry credentials.
//
// Rate limiting: 5 failed logins per visitor -> 15 minute lockout, in-memory.
// 2.43 (H7): behind cloudflared every request arrives from 127.0.0.1, so the
// limiter used to be global - five bad guesses from anyone on the internet
// locked the owner out. It now keys on the visitor address the local proxy
// reports (cf-connecting-ip, then x-forwarded-for), and believes those headers
// only when the connection itself comes from a trusted proxy (loopback by
// default), so a LAN client cannot dodge the limit by inventing one.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE = "u1hub_session";
const SESSION_DAYS = 30;
const RL_MAX_FAILS = 5;
const RL_WINDOW_MS = 15 * 60 * 1000;

module.exports = function mountAuth(app, express, baseDir, assetDir) {
  const AUTH_PATH = path.join(baseDir, "auth.json");

  let A = load();
  function load() {
    try { return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")); }
    catch { return { mode: "open" }; }
  }
  function save() {
    try { fs.writeFileSync(AUTH_PATH, JSON.stringify(A, null, 2)); } catch {}
  }
  function ensureSecret() {
    if (!A.secret) { A.secret = crypto.randomBytes(32).toString("hex"); save(); }
  }

  // ---- password hashing (scrypt) ----
  function hashPassword(pw, saltHex) {
    return crypto.scryptSync(String(pw), Buffer.from(saltHex, "hex"), 64).toString("hex");
  }
  function setPassword(pw) {
    A.salt = crypto.randomBytes(16).toString("hex");
    A.hash = hashPassword(pw, A.salt);
  }
  function checkPassword(pw) {
    if (!A.salt || !A.hash) return false;
    const h = Buffer.from(hashPassword(pw, A.salt), "hex");
    const want = Buffer.from(A.hash, "hex");
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  }

  // ---- stateless session tokens: "<expiry-ms>.<hmac(secret, expiry|credentials)>" ----
  // 2.43 (H7): the MAC also covers the current credentials (password hash and
  // the settings version), so changing the password or the auth mode retires
  // every cookie issued before it. A stolen cookie no longer outlives the
  // password it was issued under. Tokens from 2.42 and older fail this check
  // once, on upgrade, and the browser is sent to the login page.
  function credTag() { return (A.hash || "") + "|" + (A.ver || 0); }
  function macFor(exp) {
    return crypto.createHmac("sha256", A.secret).update(String(exp) + "|" + credTag()).digest("hex");
  }
  function signSession() {
    ensureSecret();
    const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
    return exp + "." + macFor(exp);
  }
  function verifySession(token) {
    if (!token || !A.secret) return false;
    const dot = token.indexOf(".");
    if (dot < 1) return false;
    const exp = token.slice(0, dot), mac = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Date.now() > +exp) return false;
    const want = macFor(exp);
    const a = Buffer.from(mac), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function readCookie(req) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return null;
  }
  function setCookie(res, value, maxAgeSec) {
    // No Secure flag: the Hub is plain HTTP on the LAN today. Revisit when the
    // Cloudflare-tunnel HTTPS work lands (v2.7.0 roadmap).
    res.setHeader("Set-Cookie",
      `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
  }

  // ---- who is really on the other end (H7) ----
  // The socket address is the only thing the client cannot write. Headers that
  // name an identity or a visitor address are believed only when that socket
  // belongs to a proxy the owner trusts: loopback by default (cloudflared and a
  // local Authelia/Authentik proxy both connect from this machine), or the
  // addresses listed in auth.json's trusted_proxies.
  const norm = a => String(a || "").replace(/^::ffff:/, "");
  function socketAddr(req) { return norm(req.socket && req.socket.remoteAddress); }
  function fromTrustedProxy(req) {
    const a = socketAddr(req);
    const list = Array.isArray(A.trusted_proxies) && A.trusted_proxies.length
      ? A.trusted_proxies.map(norm) : ["127.0.0.1", "::1"];
    return list.includes(a);
  }
  function clientKey(req) {
    if (fromTrustedProxy(req)) {
      const cf = String(req.headers["cf-connecting-ip"] || "").trim();
      if (cf) return norm(cf);
      const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (xff) return norm(xff);
    }
    return socketAddr(req) || "?";
  }

  function isAuthed(req) {
    if (A.mode === "forward") {
      // The identity header only counts when the proxy that injects it is the
      // one talking to us. A direct hit with a hand-written Remote-User is refused.
      const h = String(A.header || "Remote-User").toLowerCase();
      return !!req.headers[h] && fromTrustedProxy(req);
    }
    if (A.mode !== "password") return true; // open / proxy
    return verifySession(readCookie(req));
  }

  // ---- login rate limiting ----
  const FAILS = new Map(); // ip -> [timestamps]
  function rateLimited(ip) {
    const now = Date.now();
    const list = (FAILS.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
    FAILS.set(ip, list);
    return list.length >= RL_MAX_FAILS;
  }
  function recordFail(ip) { (FAILS.get(ip) || FAILS.set(ip, []).get(ip)).push(Date.now()); }

  // ---- the gate ----
  // Registered BEFORE express.static and every route, so it fronts the whole
  // Hub. Allowlist: the auth endpoints and page themselves, plus the minimum
  // the browser/PWA needs before login (manifest, icons, service worker).
  // v2.40: /api/models/print-request is the one API route a DIFFERENT
  // server calls (3mf-explorer, server-to-server, no browser and no Hub
  // login session to send) - it is allow-listed past the cookie/session
  // gate here and authenticates itself instead, with its own shared-secret
  // check (models.js: X-U1-Token against config.json's models.explorerToken).
  // Every other /api/models/* route is unaffected and still needs a real
  // Hub session, same as before.
  const ALLOW = new Set(["/auth.html", "/manifest.json", "/sw.js",
                         "/icon-192.png", "/icon-512.png", "/favicon.ico",
                         "/api/models/print-request"]);
  app.use((req, res, next) => {
    const p = req.path;
    if (ALLOW.has(p) || p.startsWith("/api/auth/")) return next();
    if (isAuthed(req)) return next();
    if (p.startsWith("/api/")) return res.status(401).json({ error: "Not logged in" });
    res.redirect(302, "/auth.html");
  });

  // Login/setup page — explicit route for packaged-binary reliability,
  // same pattern as "/" and "/fs-colors.html".
  app.get("/auth.html", (req, res) => {
    try { res.type("html").send(fs.readFileSync(path.join(assetDir, "public", "auth.html"), "utf8")); }
    catch (e) { res.status(500).send("auth.html not found"); }
  });

  // ---- API ----
  app.get("/api/auth/status", (req, res) => {
    res.json({ mode: A.mode, configured: A.mode !== "open", authed: isAuthed(req) });
  });

  // First-time setup, or settings changes once logged in.
  // Body: { mode: "open"|"password"|"proxy"|"forward", password?, header? }
  app.post("/api/auth/setup", (req, res) => {
    const firstRun = A.mode === "open" || (A.mode === "password" && !A.hash);
    if (!firstRun && !isAuthed(req))
      return res.status(401).json({ error: "Log in before changing auth settings" });
    const { mode, password, header } = req.body || {};
    if (!["open", "password", "proxy", "forward"].includes(mode))
      return res.status(400).json({ error: "Bad mode" });
    if (mode === "password") {
      if (!password || String(password).length < 4)
        return res.status(400).json({ error: "Password must be at least 4 characters" });
      setPassword(password);
    } else { delete A.salt; delete A.hash; }
    if (mode === "forward") {
      A.header = String(header || "Remote-User");
      const px = (req.body || {}).proxies;
      if (Array.isArray(px)) A.trusted_proxies = px.map(x => String(x).trim()).filter(Boolean).slice(0, 16);
    }
    A.mode = mode;
    A.ver = (A.ver || 0) + 1;      // H7: any auth change retires the old sessions
    ensureSecret();
    save();
    // Setting a password logs you in on the spot.
    if (mode === "password") setCookie(res, signSession(), SESSION_DAYS * 24 * 3600);
    res.json({ ok: true, mode: A.mode });
  });

  app.post("/api/auth/login", (req, res) => {
    if (A.mode !== "password") return res.status(400).json({ error: "Login is not enabled" });
    const ip = clientKey(req);       // H7: the visitor, not the tunnel
    if (rateLimited(ip))
      return res.status(429).json({ error: "Too many attempts — locked out for 15 minutes" });
    const { password } = req.body || {};
    if (!checkPassword(password)) {
      recordFail(ip);
      return res.status(401).json({ error: "Wrong password" });
    }
    FAILS.delete(ip);
    setCookie(res, signSession(), SESSION_DAYS * 24 * 3600);
    res.json({ ok: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    setCookie(res, "gone", 0);
    res.json({ ok: true });
  });

  // v2.21: the gate above is Express middleware, and a WebSocket UPGRADE never
  // reaches Express — Node hands it to the server's 'upgrade' event instead.
  // modules/klipper.js proxies Moonraker's socket, so it has to run the same
  // check itself. Returning the predicate is the whole export: nothing else in
  // this closure is anyone's business, and re-implementing a session check
  // elsewhere is how two definitions of "logged in" start drifting apart.
  return { isAuthed };
};
