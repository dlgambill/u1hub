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
// created on first setup; trusted_proxies is the list of proxy addresses -
// IPs or CIDRs - whose forwarded headers are believed, loopback when absent;
// ver is bumped by every credential change and by "sign out everywhere").
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
const net = require("net");
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
    return list.some(entry => addrMatches(a, entry));
  }
  // H24 (2.45): an entry is a plain address or a CIDR ("10.0.0.0/24",
  // "fd00::/64"). Hand-rolled on net.isIP so no dependency is added; an
  // entry that does not parse matches nothing (and setup refuses to save one).
  function addrBits(a) {
    const v = net.isIP(a);
    if (v === 4) return { bits: a.split(".").map(Number).reduce((acc, o) => (acc << 8n) + BigInt(o), 0n), len: 32 };
    if (v === 6) {
      let [head, tail] = a.split("::");
      const hs = head ? head.split(":") : [], ts = tail ? tail.split(":") : [];
      // an embedded IPv4 tail ("::ffff:1.2.3.4") counts as two groups
      const expand = g => g.includes(".") ? g.split(".").map(Number).reduce((acc, o) => (acc << 8n) + BigInt(o), 0n).toString(16).padStart(8, "0").match(/.{4}/g) : [g];
      const H = hs.flatMap(expand), T = ts.flatMap(expand);
      const groups = tail === undefined ? H : [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T];
      if (groups.length !== 8) return null;
      return { bits: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16) || 0), 0n), len: 128 };
    }
    return null;
  }
  function parseProxyEntry(entry) {
    const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(String(entry || "").trim());
    if (!m) return null;
    const base = addrBits(norm(m[1]));
    if (!base) return null;
    const prefix = m[2] === undefined ? base.len : +m[2];
    if (prefix > base.len) return null;
    return { ...base, prefix };
  }
  function addrMatches(addr, entry) {
    const e = parseProxyEntry(entry), a = addrBits(addr);
    if (!e || !a || e.len !== a.len) return false;
    const shift = BigInt(e.len - e.prefix);
    return (e.bits >> shift) === (a.bits >> shift);
  }
  // The list as saved: trimmed strings, at most 16, every one parseable.
  // Returns { list } or { error } naming the first bad entry.
  function validateProxies(px) {
    if (!Array.isArray(px)) return { error: "trusted_proxies must be a list of IPs or CIDRs" };
    const list = px.map(x => String(x == null ? "" : x).trim()).filter(Boolean);
    if (list.length > 16) return { error: "at most 16 trusted proxies" };
    const bad = list.find(x => !parseProxyEntry(x));
    if (bad !== undefined) return { error: "\"" + bad.slice(0, 60) + "\" is not an IP address or CIDR range" };
    return { list };
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
    const authed = isAuthed(req);
    res.json({ mode: A.mode, configured: A.mode !== "open", authed,
               // H24: the Settings card edits this; only shown to someone who is in
               trusted_proxies: authed ? (Array.isArray(A.trusted_proxies) ? A.trusted_proxies : []) : undefined });
  });

  // First-time setup, or settings changes once logged in.
  // Body: { mode: "open"|"password"|"proxy"|"forward", password?, header? }
  app.post("/api/auth/setup", (req, res) => {
    const firstRun = A.mode === "open" || (A.mode === "password" && !A.hash);
    if (!firstRun && !isAuthed(req))
      return res.status(401).json({ error: "Log in before changing auth settings" });
    const { mode, password, header } = req.body || {};
    // H24 (2.45): the trusted-proxy list, in any mode. A body that carries
    // only the list (no mode) changes nothing else - not the mode, not the
    // password, not the session version, so the caller stays signed in.
    const pxIn = (req.body || {}).trusted_proxies !== undefined ? (req.body || {}).trusted_proxies : (req.body || {}).proxies;
    let px = null;
    if (pxIn !== undefined) {
      const v = validateProxies(pxIn);
      if (v.error) return res.status(400).json({ error: v.error });
      px = v.list;
    }
    if (mode === undefined && px) {
      if (px.length) A.trusted_proxies = px; else delete A.trusted_proxies;
      save();
      return res.json({ ok: true, mode: A.mode, trusted_proxies: A.trusted_proxies || [] });
    }
    if (!["open", "password", "proxy", "forward"].includes(mode))
      return res.status(400).json({ error: "Bad mode" });
    // H23 (2.44): the built-in tunnel and a proxy-trusting auth mode are
    // mutually exclusive. tunnel.js refuses to start unless the mode is
    // password; this is the other direction.
    const tunnelOn = typeof req.app.locals.tunnelRunning === "function" && req.app.locals.tunnelRunning();
    if (mode !== "password" && tunnelOn)
      return res.status(409).json({ error: "The Cloudflare tunnel is running. Stop it before switching to '" + mode + "' mode - the tunnel delivers visitors straight to the Hub, so a mode that trusts a proxy header (or no gate at all) would let anyone on the internet in." });
    if (mode === "password") {
      if (!password || String(password).length < 4)
        return res.status(400).json({ error: "Password must be at least 4 characters" });
      setPassword(password);
    } else { delete A.salt; delete A.hash; }
    if (mode === "forward") A.header = String(header || "Remote-User");
    if (px) { if (px.length) A.trusted_proxies = px; else delete A.trusted_proxies; }
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

  // H24 (2.45): retire every session at once - a phone that went missing, a
  // browser left signed in somewhere. Sessions are stateless and bound to
  // `ver` (H7), so bumping it is the whole mechanism: every cookie issued
  // before this moment, the caller's included, fails verification from the
  // next request on. Only meaningful in password mode: open and proxy modes
  // have no Hub sessions to retire, and forward mode's sessions belong to the
  // proxy - a 409 says which, rather than a 200 that changed nothing.
  app.post("/api/auth/signout-everywhere", (req, res) => {
    if (A.mode !== "password")
      return res.status(409).json({ error: A.mode === "forward"
        ? "Sessions are held by your forward-auth proxy - sign out there."
        : "The Hub is in " + A.mode + " mode: there are no sessions to sign out." });
    if (!isAuthed(req)) return res.status(401).json({ error: "Not logged in" });
    A.ver = (A.ver || 0) + 1;
    save();
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
