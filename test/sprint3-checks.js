// test/sprint3-checks.js - Sprint 3 (2.44.0) checks, run by run-tests.js and
// runnable alone: `node test/sprint3-checks.js`.
//
// H5  pollJob gives up after 15 misses; a push blocks only its own card.
// H6  one fetch interceptor bounces a 401 to /auth.html?next=.
// H8  tunnel: pinned release + sha256, bounded download, relaunch with backoff,
//     integrity check before launch.
// H9  shelf read once per plan; file info cached by path+size+mtime.
// H11 pollers and camera frames pause while the tab is hidden.
// H23 auth mode cannot leave "password" while the tunnel runs.
//
// Client-side behavior is checked at the source level (the harness has no
// DOM); server-side behavior is exercised on bare Express apps in temp dirs.
"use strict";
const fs = require("fs"), os = require("os"), path = require("path");
const REPO = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(REPO, p), "utf8");

async function withApp(mount, fn) {
  const express = require(path.join(REPO, "node_modules", "express"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-s3-"));
  const app = express();
  app.use(express.json());
  mount(app, express, dir);
  app.get("/api/ping", (req, res) => res.json({ ok: true }));
  const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const call = async (method, p, { body, headers } = {}) => {
    const r = await fetch(base + p, { method, redirect: "manual",
      headers: Object.assign(body ? { "Content-Type": "application/json" } : {}, headers || {}),
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try { await fn(call, dir, app); }
  finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = async function sprint3Checks(ok) {
  const app = read("public/app.js");

  // ---- H5 ----
  ok(/POLL_MAX_MISSES\s*=\s*15/.test(app) && /\+\+misses\s*>=\s*POLL_MAX_MISSES/.test(app),
    "H5: pollJob stops after 15 consecutive failed polls instead of looping forever");
  ok(/const PUSHING\s*=\s*new Set\(\)/.test(app) && /PUSHING\.add\(printer\)/.test(app) && /PUSHING\.delete\(printer\)/.test(app),
    "H5: the printers with a push in flight are tracked per card");
  ok(!/if\(PUSHES>0 \|\| PICKOPEN \|\| INTERACTING\) return true;/.test(app) && /if\(PICKOPEN \|\| INTERACTING\) return true;/.test(app),
    "H5: a push no longer blocks every fleet re-render");
  ok(/keep\.has\(p\.id\)\)\{ wrap\.appendChild\(keep\.get\(p\.id\)\); return; \}/.test(app) && /card\.dataset\.printer=String\(p\.id\)/.test(app),
    "H5: renderFleet keeps the pushing card's DOM and rebuilds the rest");

  // ---- H6 ----
  ok(/window\.fetch=async function\(input, init\)/.test(app) && /r\.status===401/.test(app) && /\/auth\.html\?next=/.test(app),
    "H6: one fetch interceptor sends an ended session to /auth.html?next=");
  ok(/!\/\^\\\/api\\\/auth\\\/\/\.test\(u\)/.test(app), "H6: ...but never for /api/auth/* itself (login must be able to fail with 401)");
  const authHtml = read("public/auth.html");
  ok(/function nextUrl\(\)/.test(authHtml) && /location\.href = nextUrl\(\)/.test(authHtml) && /\^\\\/\(\?!\\\/\)/.test(authHtml),
    "H6: auth.html returns to ?next= after sign-in, same-origin paths only");

  // ---- H11 ----
  const hidden = (app.match(/document\.hidden/g) || []).length;
  ok(hidden >= 6, "H11: every poller and the camera tick check document.hidden (" + hidden + " checks)", hidden);
  ok(/addEventListener\("visibilitychange"/.test(app) && /loadFleet\(\); loadFiles\(\); loadQueue\(\);/.test(app),
    "H11: coming back to the tab refreshes once");

  // ---- upload error text (hand test on 2.42.0) ----
  const printSrc = read("core/print.js");
  ok(/sock\.once\("connect", \(\) => \{ connected = true; \}\)/.test(printSrc) && /could not connect to " \+ u\.hostname/.test(printSrc),
    "2.44: an upload to a printer that never accepted the connection says 'could not connect', not 'stalled'");

  // ---- S3/S4/S7 client half ----
  const dui = read("public/modules/dispatch-ui.js");
  ok(/function onEvent\(name, data\)/.test(dui) && /onShow, onFleet, onEvent,/.test(dui) && /ES\.addEventListener\("dispatch"/.test(app),
    "S4: the Dispatch tab subscribes to the pushed plan and redraws the timeline from it");
  ok(/data-dsp-est=/.test(dui) && /est_minutes: v === "" \? null : \+v/.test(dui), "S3: a job's runtime can be typed on its row (empty = back to the file's estimate)");
  ok(/\["Why here",/.test(dui) && /Next best: /.test(dui), "S7: the slot panel explains the choice and lists the runners-up");
  ok(/this file usually takes this long here/.test(dui), "S3: the slot panel says where the runtime came from");

  // ---- H9 ----
  const disp = read("modules/dispatch.js");
  ok(/const shelfNow = shelfByHex\(\);/.test(disp) && /swapsFor\(job\.colors, l\.fp, shelfNow\)/.test(disp),
    "H9: plan() reads the spool shelf once and hands it to every swapsFor call");
  ok(/SHELF_MEMO/.test(disp), "H9: shelfByHex memoizes for callers outside plan()");
  const mods = read("core/modules.js");
  ok(/FILE_INFO_CACHE = new Map\(\)/.test(mods) && /fp \+ "\|" \+ st0\.size \+ "\|" \+ Math\.round\(st0\.mtimeMs\)/.test(mods),
    "H9: fileInfoForModules caches by path + size + mtime");

  // ---- H8: tunnel module on a bare app ----
  const tunnelSrc = read("tunnel.js");
  ok(!/releases\/latest\/download/.test(tunnelSrc) && /PINNED\s*=\s*\{\s*version:\s*"\d{4}\.\d+\.\d+"/.test(tunnelSrc),
    "H8: cloudflared is downloaded from a pinned release, not /latest/");
  ok(/req\.setTimeout\(/.test(tunnelSrc) && /DOWNLOAD_MAX_BYTES/.test(tunnelSrc), "H8: the download has a timeout and a size cap");
  ok(/relaunchDelay = Math\.min\(RELAUNCH_MAX_MS, relaunchDelay \* 2\)/.test(tunnelSrc) && /if \(T\.autostart\) \{/.test(tunnelSrc),
    "H8: an unexpected exit with autostart on schedules a relaunch with exponential backoff");
  await withApp((app, express, dir) => {
    // a fake "binary" whose recorded hash does not match what is on disk
    const bin = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
    fs.writeFileSync(bin, "#!/bin/sh\necho cloudflared version 0.0.0\n");
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ mode: "password", salt: "a", hash: "b", secret: "s" }));
    fs.writeFileSync(path.join(dir, "tunnel.json"), JSON.stringify({ mode: "quick", token: "", hostname: "", autostart: false, binSha256: "0".repeat(64) }));
    require(path.join(REPO, "tunnel.js"))(app, express, dir, 4545);
  }, async (call) => {
    let r = await call("GET", "/api/tunnel/status");
    ok(r.status === 200 && r.body && r.body.pinned && /^\d{4}\.\d+\.\d+$/.test(r.body.pinned.version),
      "H8: /api/tunnel/status reports the pinned cloudflared version", r.body && r.body.pinned);
    r = await call("POST", "/api/tunnel/start");
    ok(r.status === 409 && /sha256 differs/.test(String(r.body && r.body.error)),
      "H8: a binary whose hash differs from the recorded download is refused before launch", r.body);
  });

  // ---- H23: auth mode locked to password while the tunnel runs ----
  await withApp((app, express, dir) => {
    require(path.join(REPO, "auth.js"))(app, express, dir, REPO);
    app.locals.tunnelRunning = () => true;
  }, async (call) => {
    let r = await call("POST", "/api/auth/setup", { body: { mode: "password", password: "first-pass" } });
    ok(r.status === 200, "H23: password mode can be set up while the tunnel runs", r.status);
    r = await call("POST", "/api/auth/setup", { body: { mode: "open" }, headers: {} });
    ok(r.status === 401 || r.status === 409, "H23: leaving password mode needs a login and is refused while the tunnel runs", r.status);
  });
  await withApp((app, express, dir) => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ mode: "open", secret: "s" }));
    require(path.join(REPO, "auth.js"))(app, express, dir, REPO);
    app.locals.tunnelRunning = () => true;
  }, async (call) => {
    const r = await call("POST", "/api/auth/setup", { body: { mode: "forward", header: "Remote-User" } });
    ok(r.status === 409 && /tunnel is running/i.test(String(r.body && r.body.error)),
      "H23: switching to forward mode is refused with the reason while the tunnel runs", r.body);
  });
  await withApp((app, express, dir) => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ mode: "open", secret: "s" }));
    require(path.join(REPO, "auth.js"))(app, express, dir, REPO);
    app.locals.tunnelRunning = () => false;
  }, async (call) => {
    const r = await call("POST", "/api/auth/setup", { body: { mode: "forward", header: "Remote-User" } });
    ok(r.status === 200, "H23: ...and allowed when the tunnel is off", r.status);
  });
};

if (require.main === module) {
  let pass = 0, fail = 0;
  module.exports((c, n, d) => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } })
    .then(() => { console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
