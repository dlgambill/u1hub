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
// auth.json: { mode, salt, hash, secret, header }  (salt/hash only in
// password mode; secret signs session cookies and is created on first setup).
// Kept OUT of config.json deliberately — /api/config echoes config to the
// settings UI and must never carry credentials.
//
// Rate limiting: 5 failed logins per IP -> 15 minute lockout, in-memory.
// NOTE: without Express "trust proxy", req.ip behind a reverse proxy is the
// proxy's address, so the lockout becomes global rather than per-visitor.
// Acceptable for a LAN dashboard; forward/proxy modes don't use login at all.

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

  // ---- stateless session tokens: "<expiry-ms>.<hmac(secret, expiry)>" ----
  function signSession() {
    ensureSecret();
    const exp = Date.now() + SESSION_DAYS * 24 * 3600 * 1000;
    const mac = crypto.createHmac("sha256", A.secret).update(String(exp)).digest("hex");
    return exp + "." + mac;
  }
  function verifySession(token) {
    if (!token || !A.secret) return false;
    const dot = token.indexOf(".");
    if (dot < 1) return false;
    const exp = token.slice(0, dot), mac = token.slice(dot + 1);
    if (!/^\d+$/.test(exp) || Date.now() > +exp) return false;
    const want = crypto.createHmac("sha256", A.secret).update(exp).digest("hex");
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

  function isAuthed(req) {
    if (A.mode === "forward") {
      const h = String(A.header || "Remote-User").toLowerCase();
      return !!req.headers[h];
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
  const ALLOW = new Set(["/auth.html", "/manifest.json", "/sw.js",
                         "/icon-192.png", "/icon-512.png", "/favicon.ico"]);
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
    if (mode === "forward") A.header = String(header || "Remote-User");
    A.mode = mode;
    ensureSecret();
    save();
    // Setting a password logs you in on the spot.
    if (mode === "password") setCookie(res, signSession(), SESSION_DAYS * 24 * 3600);
    res.json({ ok: true, mode: A.mode });
  });

  app.post("/api/auth/login", (req, res) => {
    if (A.mode !== "password") return res.status(400).json({ error: "Login is not enabled" });
    const ip = req.ip || req.socket.remoteAddress || "?";
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
};
