// test/h7-auth-checks.js - H7 (2.43.0) auth checks, run by run-tests.js and
// runnable alone: `node test/h7-auth-checks.js`.
//
// auth.js is mounted on a bare Express app in a temp dir so each auth mode can
// be set up from a known auth.json without touching the harness Hub (which runs
// in "open" mode). Every request comes from 127.0.0.1, so "a client on the
// LAN" is simulated by an allowlist that does not include loopback.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const REPO = path.resolve(__dirname, "..");

async function withAuth(authJson, fn) {
  const express = require(path.join(REPO, "node_modules", "express"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-h7-"));
  if (authJson) fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(authJson));
  const app = express();
  app.use(express.json());
  require(path.join(REPO, "auth.js"))(app, express, dir, REPO);
  app.get("/api/ping", (req, res) => res.json({ ok: true }));
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const call = async (method, p, { body, headers } = {}) => {
    const r = await fetch(base + p, { method, redirect: "manual",
      headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, headers || {}),
      body: body ? JSON.stringify(body) : undefined });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    return { status: r.status, body: await r.json().catch(() => null), cookie };
  };
  try { await fn(call, dir); }
  finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = async function h7Checks(ok) {
  // Forward mode: the identity header counts only from a trusted proxy.
  await withAuth({ mode: "forward", header: "Remote-User", secret: "s" }, async call => {
    const r = await call("GET", "/api/ping", { headers: { "Remote-User": "danny" } });
    ok(r.status === 200, "H7: forward mode accepts the identity header from the local proxy (loopback, the default)", r.status);
  });
  await withAuth({ mode: "forward", header: "Remote-User", secret: "s", trusted_proxies: ["10.9.9.9"] }, async call => {
    const r = await call("GET", "/api/ping", { headers: { "Remote-User": "danny" } });
    ok(r.status === 401, "H7: forward mode refuses a Remote-User header from an address that is not a trusted proxy", r.status);
  });

  // Password mode: limiter per visitor, sessions bound to the password.
  await withAuth(null, async call => {
    let r = await call("POST", "/api/auth/setup", { body: { mode: "password", password: "first-pass" } });
    const cookie1 = r.cookie;
    ok(r.status === 200 && /u1hub_session=/.test(cookie1), "H7: setup logs in with a session cookie", r.status);
    const asA = { "cf-connecting-ip": "203.0.113.7" }, asB = { "cf-connecting-ip": "198.51.100.9" };
    for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { body: { password: "wrong" }, headers: asA });
    r = await call("POST", "/api/auth/login", { body: { password: "first-pass" }, headers: asA });
    ok(r.status === 429, "H7: five bad guesses lock out that visitor (cf-connecting-ip)", r.status);
    r = await call("POST", "/api/auth/login", { body: { password: "first-pass" }, headers: asB });
    ok(r.status === 200, "H7: ...but not the owner arriving through the same tunnel from another address", r.status);
    r = await call("GET", "/api/ping", { headers: { cookie: cookie1 } });
    ok(r.status === 200, "H7: the session cookie opens the API", r.status);
    r = await call("POST", "/api/auth/setup", { body: { mode: "password", password: "second-pass" }, headers: { cookie: cookie1 } });
    const cookie2 = r.cookie;
    ok(r.status === 200, "H7: the password can be changed while logged in", r.status);
    r = await call("GET", "/api/ping", { headers: { cookie: cookie1 } });
    ok(r.status === 401, "H7: changing the password retires every older session cookie", r.status);
    r = await call("GET", "/api/ping", { headers: { cookie: cookie2 } });
    ok(r.status === 200, "H7: ...and the new cookie works", r.status);
  });

  // A LAN client cannot invent a visitor address to dodge the limiter.
  // Loopback is made NOT a trusted proxy here, so forwarded headers must be
  // ignored and the limiter keys on the socket address.
  await withAuth(null, async (call, dir) => {
    await call("POST", "/api/auth/setup", { body: { mode: "password", password: "pw-1234" } });
    const file = path.join(dir, "auth.json");
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    ok(a.ver >= 1, "H7: auth.json carries the settings version that sessions are bound to", a.ver);
  });
  await withAuth({ mode: "open", trusted_proxies: ["10.9.9.9"] }, async call => {
    await call("POST", "/api/auth/setup", { body: { mode: "password", password: "pw-1234" } });
    for (let i = 0; i < 5; i++)
      await call("POST", "/api/auth/login", { body: { password: "wrong" }, headers: { "cf-connecting-ip": "192.0.2." + (i + 1) } });
    const r = await call("POST", "/api/auth/login", { body: { password: "pw-1234" }, headers: { "cf-connecting-ip": "192.0.2.99" } });
    ok(r.status === 429, "H7: a client that is not a trusted proxy cannot dodge the limiter by inventing cf-connecting-ip", r.status);
  });

  // ---- H24 (2.45): sign out everywhere, editable trusted proxies ----
  await withAuth(null, async (call, dir) => {
    let r = await call("POST", "/api/auth/signout-everywhere");
    ok(r.status === 409 && /open mode/.test(r.body && r.body.error || ""), "H24: sign-out-everywhere in open mode is a 409 that says why", r.status, r.body);
    r = await call("POST", "/api/auth/setup", { body: { mode: "password", password: "pw-1234" } });
    const c1 = r.cookie;
    r = await call("POST", "/api/auth/login", { body: { password: "pw-1234" } });
    const c2 = r.cookie;
    ok((await call("GET", "/api/ping", { headers: { cookie: c1 } })).status === 200 && (await call("GET", "/api/ping", { headers: { cookie: c2 } })).status === 200, "H24: two devices are signed in");
    r = await call("POST", "/api/auth/signout-everywhere");
    ok(r.status === 401, "H24: sign-out-everywhere needs a signed-in session (401 without one)", r.status);
    r = await call("POST", "/api/auth/signout-everywhere", { headers: { cookie: c1 } });
    ok(r.status === 200 && r.body && r.body.ok === true, "H24: a signed-in caller can sign out everywhere", r.status);
    ok((await call("GET", "/api/ping", { headers: { cookie: c1 } })).status === 401 && (await call("GET", "/api/ping", { headers: { cookie: c2 } })).status === 401,
      "H24: ...and every older cookie, the caller's included, is now 401");
    r = await call("POST", "/api/auth/login", { body: { password: "pw-1234" } });
    ok(r.status === 200 && (await call("GET", "/api/ping", { headers: { cookie: r.cookie } })).status === 200, "H24: the password still works and a fresh sign-in is accepted");
    const c3 = r.cookie;
    // trusted_proxies: saved through the setup route without a mode, validated.
    r = await call("POST", "/api/auth/setup", { body: { trusted_proxies: ["10.9.9.9", "192.168.1.0/24", "fd00::/64"] }, headers: { cookie: c3 } });
    ok(r.status === 200 && r.body && r.body.trusted_proxies.length === 3, "H24: trusted_proxies saves (IPs and CIDRs) without touching the mode", r.status, r.body);
    const a = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    ok(a.mode === "password" && Array.isArray(a.trusted_proxies) && a.trusted_proxies[1] === "192.168.1.0/24" && a.hash, "H24: auth.json carries the list, the mode and the password are untouched", a);
    ok((await call("GET", "/api/ping", { headers: { cookie: c3 } })).status === 200, "H24: saving the proxy list does not sign the caller out");
    for (const bad of [["not-an-ip"], ["10.0.0.0/33"], ["10.0.0.256"], "10.9.9.9", ["1.2.3.4", "junk/8"]]) {
      r = await call("POST", "/api/auth/setup", { body: { trusted_proxies: bad }, headers: { cookie: c3 } });
      ok(r.status === 400 && r.body && r.body.error, "H24: garbage is refused with the entry named: " + JSON.stringify(bad), r.status, r.body);
    }
    const after = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    ok(after.trusted_proxies.length === 3, "H24: a refused save leaves the list as it was");
    r = await call("GET", "/api/auth/status", { headers: { cookie: c3 } });
    ok(r.body && Array.isArray(r.body.trusted_proxies) && r.body.trusted_proxies.length === 3, "H24: /api/auth/status shows the list to a signed-in caller");
    r = await call("GET", "/api/auth/status");
    ok(r.body && r.body.trusted_proxies === undefined, "H24: ...and not to anyone else");
    r = await call("POST", "/api/auth/setup", { body: { trusted_proxies: [] }, headers: { cookie: c3 } });
    ok(r.status === 200 && !("trusted_proxies" in JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"))), "H24: an empty list clears it (back to loopback only)");
  });
  // CIDR entries match the way an exact address always has.
  await withAuth({ mode: "forward", header: "Remote-User", secret: "s", trusted_proxies: ["127.0.0.0/8"] }, async call => {
    const r = await call("GET", "/api/ping", { headers: { "Remote-User": "danny" } });
    ok(r.status === 200, "H24: a CIDR that covers loopback trusts the local proxy", r.status);
  });
  await withAuth({ mode: "forward", header: "Remote-User", secret: "s", trusted_proxies: ["10.0.0.0/8", "::1/128"] }, async call => {
    const r = await call("GET", "/api/ping", { headers: { "Remote-User": "danny" } });
    ok(r.status === 401, "H24: a CIDR that does not cover the socket address trusts nothing", r.status);
  });

  // Print-request token: constant-time comparison.
  const models = fs.readFileSync(path.join(REPO, "modules", "models.js"), "utf8");
  const route = models.slice(models.indexOf('app.post("/api/models/print-request"'), models.indexOf('app.get("/api/models/print-requests"'));
  ok(/timingSafeEqual/.test(models) && !/tok\s*!==\s*EXPLORER_TOKEN/.test(route),
    "H7: the print-request token is compared with crypto.timingSafeEqual, not !==");
};

if (require.main === module) {
  let pass = 0, fail = 0;
  module.exports((c, n, d) => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } })
    .then(() => { console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
