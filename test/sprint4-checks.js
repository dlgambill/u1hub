// test/sprint4-checks.js - Sprint 4 (2.45.0) checks, run by run-tests.js and
// runnable alone: `node test/sprint4-checks.js`.
//
// H10 one fleet snapshot loop; records, events and dispatch subscribe to it.
//
// Client-side behavior is checked at the source level (the harness has no
// DOM); server-side pieces that need no running Hub are called directly.
"use strict";
const fs = require("fs"), path = require("path");
const REPO = path.resolve(__dirname, "..");
// CRLF-safe: the Windows worktree checks out with autocrlf, and three checks match across a line break.
const read = p => fs.readFileSync(path.join(REPO, p), "utf8").replace(/\r\n/g, "\n");

module.exports = async function sprint4Checks(ok) {
  // ---- H10 ----
  const fleet = read("core/fleet.js"), records = read("core/records.js"), events = read("core/events.js"), dispatch = read("modules/dispatch.js");
  const loops = (fleet.match(/setInterval\(\(\) => \{ fleetTick\(\)/g) || []).length;
  ok(loops === 1 && /hub\.events\.listeners\("fleet:tick"\)/.test(fleet), "H10: core/fleet.js runs exactly one scheduled snapshot loop and emits fleet:tick from it", loops);
  ok(!/setInterval\(pollPrintStarts/.test(records) && !/async function probeState/.test(records) && /hub\.events\.on\("fleet:tick"/.test(records),
    "H10: the print-start watcher has no poller and no probes of its own - it reads the loop's snapshot");
  ok(!/setInterval\(\(\) => \{ check\(\)/.test(events) && /events\.on\("fleet:tick"/.test(events) && !/new EventEmitter\(\)/.test(events),
    "H10: fleet events run their edge detection on fleet:tick and share the hub's bus");
  ok(!/setInterval\(\(\) => \{\s*tick\(\)/.test(dispatch) && /ctx\.events\.on\("fleet:tick"/.test(dispatch) && /NEXT_EXEC = now \+ EXEC_TICK_MS - EXEC_SLACK_MS/.test(dispatch),
    "H10: the dispatch executor acts on the loop's snapshot every ~10 s instead of taking its own");
  ok(/events: new \(require\("events"\)\)\(\)/.test(read("server.js")), "H10: the event bus is created with the hub so core files loaded before the fleet can subscribe");
  const rec = fleet.slice(fleet.indexOf("RECONCILE_TIMEOUT_MS = "), fleet.indexOf("}, 20000);"));
  ok(/ctrl\.abort\(\), RECONCILE_TIMEOUT_MS/.test(rec) && /print_task_config", \{ signal: ctrl\.signal \}/.test(rec),
    "H10: the 20 s color reconcile fetch carries an AbortController, so a printer that stops answering cannot hold it open");

  // ---- H18 ----
  // S5 (2.44) marks the copy starting_on at the real start command and plan()
  // counts it in flight for 5 min; the clear-bed route itself only arms the
  // next start. What 2.44.1 left open was the running list's attribution
  // between the printer reporting the print and the executor claiming it.
  ok(/const starting = job\.printing_on == null && job\.starting_on && \(now - \(job\.starting_on\.at \|\| 0\) < STARTING_TTL_MS\)/.test(dispatch)
     && /job\.starting_on = \{ printer: idx, at: Date\.now\(\) \}/.test(dispatch),
    "H18: a hand-off counts as in flight in plan() from the start command until seen or 5 min (S5, unchanged)");
  ok(/if \(!idle && !sameFile\(sj, l\.fp, l\.idx\)\) continue;/.test(dispatch) && /l\.startingFile = sj\.file; l\.startingJob = sj\.id;\n      if \(idle\)/.test(dispatch),
    "H18: the running entry is attributed to the hand-off's job while the printer reports that file, not only while the lane looks idle");

  // ---- H12: timelapse probe off the event loop ----
  const tl = read("modules/timelapse.js");
  ok(!/spawnSync\(/.test(tl) && !/readFileSync\(job\.rawVideoPath\)/.test(tl) && !/readFileSync\(finalOut\)/.test(tl) && !/writeFileSync\(tmp, bytes\)/.test(tl),
    "H12: timelapse no longer runs ffprobe synchronously or reads whole videos on the event loop");
  ok(/execFile\("ffprobe"/.test(tl) && /await probe\(job\.rawVideoPath\)/.test(tl) && /fs\.promises\.copyFile\(srcPath, mainIn\)/.test(tl),
    "H12: ffprobe runs through execFile on the file where it sits; compositing copies it instead of buffering it");
  {
    const { probeVideo } = require(path.join(REPO, "modules", "timelapse.js"));
    const r1 = await probeVideo(path.join(REPO, "no-such-video.mp4"), 3000);
    ok(r1 && r1.duration === 0 && r1.frames === 0 && r1.width === 1920 && r1.height === 1080,
      "H12: probing a missing file resolves to the fail-open defaults, never throws", r1);
    const junk = path.join(require("os").tmpdir(), "u1hub-h12-junk-" + process.pid + ".mp4");
    fs.writeFileSync(junk, "not a video at all");
    const r2 = await probeVideo(junk, 3000).finally(() => { try { fs.unlinkSync(junk); } catch {} });
    ok(r2 && r2.duration === 0 && r2.width === 1920, "H12: an unreadable file (or no ffprobe on PATH) resolves the same way", r2);
  }

  // ---- H13: Dispatch timeline follows the fleet tick ----
  const dui = read("public/modules/dispatch-ui.js");
  ok(/function onFleet\(\) \{\n    if \(!visible\(\)\) return;\n    renderPlan\(\);/.test(dui),
    "H13: the timeline redraws on every fleet tick while the tab is showing (running bars and ETAs move)");
  ok(/const PLAN_RELOAD_MS = 60000;/.test(dui) && /setInterval\(\(\) => \{ if \(visible\(\) && !editing\(\)\) load\(\)/.test(dui) && /!document\.hidden/.test(dui),
    "H13: the plan is re-read every 60 s while visible, never from a hidden document (H11)");

  // ---- H14: pause/resume/cancel buttons ----
  const app = read("public/app.js"), idx = read("public/index.html");
  ok(/const CTLBUSY=new Map\(\)/.test(app) && /ctlBtn\(p\.id,"cancel","Cancel","danger"\)/.test(app) && /CTLBUSY\.set\(printer, act\); ctlSetBusy\(printer, act\);/.test(app),
    "H14: a pause/resume/cancel in flight disables the card's control buttons and survives the fleet re-render");
  ok(/if\(CTLBUSY\.has\(printer\)\) return;/.test(app), "H14: a second tap while one is in flight sends nothing");
  ok(/catch\(e\)\{\n    \/\/ Re-enable on error[^]*?CTLBUSY\.delete\(printer\); ctlSetBusy\(printer, null\);\n    if\(st\)\{ st\.className="pstatus err"; st\.textContent=e\.message; \}/.test(app),
    "H14: on error the buttons come back and the card's status line says why");
  ok(/\.btn\.busy::after\{[^}]*border:2px solid var\(--ink\)/.test(idx) && /@keyframes btnspin/.test(idx) && !/\.btn\.busy[^}]*#[0-9a-fA-F]{3,6}/.test(idx),
    "H14: the in-button spinner is drawn from existing tokens, no new color");

  // ---- H15: honest saves ----
  const cfg = read("core/config.js"), settings = read("core/settings.js");
  // (H19 moved the temp-then-rename itself into core/util.js atomicWrite.)
  const util = read("core/util.js");
  ok(/atomicWrite\(CONFIG_PATH, /.test(cfg) && /fs\.renameSync\(tmp, file\)/.test(util) && /hub\.SAVE_CONFIG_ERROR = \(e && e\.message\) \|\| String\(e\);/.test(cfg) && /hublog\("warn", "config: could not save/.test(cfg) && /return false;/.test(cfg),
    "H15: saveConfigFile writes temp-then-rename, returns false on failure and logs a warn");
  ok(/if \(!saveConfigFile\(next\)\) return res\.status\(500\)\.json\(\{ error: saveConfigError\(\) \}\);/.test(settings) && !/fs\.writeFileSync\(CONFIG_PATH/.test(settings),
    "H15: /api/config goes through the one writer and answers 500 with the reason");
  const guarded = ["resources", "margin", "timelapse", "updates", "spoolman", "advisor", "slicing", "notify", "models"]
    .filter(m => /if \(!ctx\.saveConfig\(\)\) return res\.status\(500\)\.json\(\{ error: ctx\.saveConfigError\(\) \}\);/.test(read("modules/" + m + ".js")));
  ok(guarded.length === 9, "H15: every module settings route answers 500 when the save fails (" + guarded.length + "/9)", guarded);
  const lib = read("core/library.js");
  ok((lib.match(/if \(!saveConfigFile\(\)\) return res\.status\(500\)\.json\(\{ error: hub\.saveConfigError\(\) \}\);/g) || []).length === 3 && !/saveConfigFile\(\);/.test(lib),
    "H15: the three type routes (add, update, delete) answer 500 when the save fails too");

  // ---- H17: metadata cache keyed by printer and file ----
  ok(/const META_CACHE = new Map\(\);/.test(fleet) && /const mk = key \+ "\\n" \+ filename;/.test(fleet) && /META_CACHE_MAX = 200/.test(fleet),
    "H17: the per-file metadata cache is keyed by printer and file and bounded");

  // ---- H19: one copy of each helper ----
  {
    // Server files: everything that runs inside the Hub process. public/ is
    // the client, test/ and scripts/ are tooling - they keep their own copies.
    const walk = (dir, out = []) => { for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "public" || e.name === "test" || e.name === "scripts" || e.name === "docs" || e.name === ".git" || e.name === "dist") continue;
      const rel = dir ? dir + "/" + e.name : e.name;
      if (e.isDirectory()) walk(rel, out); else if (/\.js$/.test(e.name)) out.push(rel);
    } return out; };
    const files = walk("");
    const withRegex = files.filter(f => read(f).includes('.replace(/\\/+$/, "")'));
    ok(withRegex.length === 1 && withRegex[0] === "core/util.js", "H19: the trailing-slash regex lives in core/util.js only (" + withRegex.join(", ") + ")");
    // core/health.js (F9) copies the file byte-for-byte for the nightly backup; it never parses it, so it is not a reader.
    const withSpools = files.filter(f => f !== "core/health.js" && read(f).includes('"spools.json"'));
    ok(withSpools.length === 1 && withSpools[0] === "core/spools.js", "H19: core/spools.js is the only server file that reads spools.json (" + withSpools.join(", ") + ")");
    const defs = files.filter(f => /function (nameMatcher|isoWeekKey|grabFrame)\(/.test(read(f)));
    ok(defs.length === 1 && defs[0] === "core/util.js", "H19: nameMatcher, isoWeekKey and grabFrame are defined once, in core/util.js (" + defs.join(", ") + ")");
    const U = require(path.join(REPO, "core", "util.js"));
    ok(U.printerUrl({ url: "http://10.0.0.5///" }) === "http://10.0.0.5" && U.printerWsUrl({ url: "http://10.0.0.5/" }) === "ws://10.0.0.5/websocket" && U.printerUrl({}) === "",
      "H19: printerUrl strips trailing slashes; printerWsUrl derives the Moonraker socket URL");
    ok(U.isoWeekKey(new Date(2026, 0, 1)) === "2026-W01" && U.isoWeekKey(new Date(2027, 0, 1).getTime()) === "2026-W53" && U.isoWeekKey(new Date(2026, 7, 31)) === "2026-W36",
      "H19: isoWeekKey is ISO 8601 (Jan 1 2027 is week 53 of 2026) and takes a Date or a timestamp");
    const m = U.nameMatcher("drag* -cave");
    ok(m("Dragon Fox") && !m("Dragon Cave") && !m("Fox Dragon") && U.nameMatcher("?ox")("Box") && !U.nameMatcher("?ox")("Box 2") && U.nameMatcher("")("anything"),
      "H19: nameMatcher does substring, * and ? (whole name), -word, and an empty query matches everything");
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "u1hub-h19-"));
    try {
      const f = path.join(dir, "x.json");
      U.atomicWrite(f, "{\"a\":1}");
      ok(fs.readFileSync(f, "utf8") === "{\"a\":1}" && !fs.existsSync(f + ".tmp"), "H19: atomicWrite lands the file and leaves no .tmp behind");
      let threw = null; try { U.atomicWrite(path.join(dir, "no-such-dir", "x.json"), "x"); } catch (e) { threw = e; }
      ok(threw && threw.code === "ENOENT", "H19: atomicWrite throws on failure so a caller can latch its fallback", threw && threw.code);
      const S = require(path.join(REPO, "core", "spools.js"));
      let r = S.readSpools(dir);
      ok(r.authoritative === true && Object.keys(r.spools).length === 0 && Array.isArray(r.local), "H19: readSpools: no file is an authoritative empty shelf");
      fs.writeFileSync(path.join(dir, "spools.json"), "{ not json");
      r = S.readSpools(dir);
      ok(r.authoritative === false && Object.keys(r.spools).length === 0, "H19: readSpools: a corrupt file is an empty shelf that is NOT authoritative");
      ok(S.writeSpools(dir, { spools: { sp_1: { hex: "ff0000" } }, tags: { u1: "sp_1" }, local: [] }) === true, "H19: writeSpools writes the file");
      r = S.readSpools(dir);
      ok(r.authoritative && r.spools.sp_1 && r.spools.sp_1.hex === "ff0000" && r.tags.u1 === "sp_1", "H19: ...and readSpools reads it back normalized");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- H24: Settings auth card (route behavior is in test/h7-auth-checks.js) ----
  ok(/id="authProxies"/.test(idx) && /id="authProxiesSave"/.test(idx) && /id="authSignoutAll"/.test(idx) && /id="authMsg"/.test(idx),
    "H24: the Settings access card has the trusted-proxies field, its save button, Sign out everywhere and a status line");
  ok(/fetch\("\/api\/auth\/setup",\{method:"POST"[^\n]*trusted_proxies: list/.test(app), "H24: the proxies save goes through /api/auth/setup with trusted_proxies only (no mode)");
  ok(/if\(!confirm\("Sign out everywhere\?/.test(app) && /fetch\("\/api\/auth\/signout-everywhere",\{method:"POST"\}\)/.test(app) && /location\.replace\("\/auth\.html"\)/.test(app),
    "H24: Sign out everywhere confirms first, calls the route, then lands on the sign-in page");
  ok(/\$\("authSignoutAll"\)\.disabled = a\.mode !== "password";/.test(app), "H24: the button is disabled outside password mode");
  ok(!/[\u2014]/.test(app.slice(app.indexOf("// H24 (2.45): trusted proxies"), app.indexOf("// ---- remote access"))) && !/[\u2014]/.test(idx.slice(idx.indexOf('id="authSignoutAll"'), idx.indexOf('Remote access <span'))),
    "H24: the new UI text uses no em dash");

  // ---- S6: bed clearing is a queue ----
  {
    const { queueBedClears, BED_CLEAR_BUFFER_MIN } = require(path.join(REPO, "modules", "dispatch.js"));
    const M = 60000, H = 60 * M;
    // A synthetic day: attended 08:00-22:00; a print that ends overnight is
    // cleared at 08:00 and ready at 08:05, exactly as readyAfter() says.
    const t = (h, m) => (h * 60 + (m || 0)) * M;
    const nextStart = ms => { const d = Math.floor(ms / (24 * H)) * 24 * H, mod = ms - d; return mod < t(8) ? d + t(8) : mod >= t(22) ? d + 24 * H + t(8) : ms; };
    const readyAfter = end => nextStart(end) + BED_CLEAR_BUFFER_MIN * M;
    const mk = (printer, start, end, why) => ({ printer, printerName: "P" + printer, est_start: start, est_end: end, delay: { bed: 0 }, why: why || { reason: "earlier finish", alternatives: [] } });
    // Three printers finish at 02:00; their first copies are placed at 08:00
    // (the lane cursor after a running print), in plan priority order 2, 0, 1.
    let lanes = [0, 1, 2].map(i => ({ idx: i, name: "P" + i, busyUntil: t(2) }));
    let slots = [mk(2, t(8), t(8) + 3 * H), mk(0, t(8), t(8) + H), mk(1, t(8), t(8) + 2 * H)];
    let n = queueBedClears(slots, lanes, readyAfter);
    ok(n === 2 && slots.map(x => x.est_start).join() === [t(8), t(8, 5), t(8, 10)].join(),
      "S6: three prints ending the same night get three distinct starts 5 min apart, in plan order (08:00, 08:05, 08:10)", slots.map(x => new Date(x.est_start).toISOString().slice(11, 16)));
    ok(slots[0].why.bed_clear === undefined && slots[1].why.bed_clear === "bed clear queued behind P2" && slots[2].why.bed_clear === "bed clear queued behind P0",
      "S6: each shifted slot says whose bed is cleared before it", slots.map(x => x.why.bed_clear));
    ok(slots[1].est_end === t(8, 5) + H && slots[1].delay.bed === 5 && slots[2].delay.bed === 10 && slots[1].why.reason === "earlier finish",
      "S6: the end and the bed wait move with the start; the S7 reason is untouched");
    // The same three, placed after planned (not running) prints that end at
    // 02:00: readyAfter puts the first at 08:05, the queue the rest at 08:10, 08:15.
    lanes = [0, 1, 2].map(i => ({ idx: i, name: "P" + i, busyUntil: null }));
    slots = [mk(0, t(0), t(2)), mk(1, t(0), t(2)), mk(2, t(0), t(2)), mk(0, t(8, 5), t(9)), mk(1, t(8, 5), t(9)), mk(2, t(8, 5), t(9))];
    n = queueBedClears(slots, lanes, readyAfter);
    ok(n === 2 && slots.slice(3).map(x => x.est_start).join() === [t(8, 5), t(8, 10), t(8, 15)].join(),
      "S6: ...and after planned prints ending together the followers queue at 08:05, 08:10, 08:15", slots.slice(3).map(x => new Date(x.est_start).toISOString().slice(11, 16)));
    // A single finish is unchanged, and a slot that starts later anyway is left alone.
    lanes = [{ idx: 0, name: "P0", busyUntil: t(2) }, { idx: 1, name: "P1", busyUntil: t(2) }];
    slots = [mk(0, t(8), t(9)), mk(1, t(14), t(15))];
    n = queueBedClears(slots, lanes, readyAfter);
    ok(n === 0 && slots[0].est_start === t(8) && slots[1].est_start === t(14) && !slots[0].why.bed_clear && !slots[1].why.bed_clear,
      "S6: a single finish is unchanged, and a follower that waits for a later window is not pulled or pushed");
    lanes = [{ idx: 0, name: "P0", busyUntil: t(2) }];
    slots = [mk(0, t(8), t(9))];
    ok(queueBedClears(slots, lanes, readyAfter) === 0 && slots[0].est_start === t(8), "S6: one printer, one finish: nothing moves");
    // A deadline verdict is re-read after the shift.
    lanes = [0, 1].map(i => ({ idx: i, name: "P" + i, busyUntil: t(2) }));
    slots = [mk(0, t(8), t(9)), Object.assign(mk(1, t(8), t(9)), { deadline: t(9, 2), misses_deadline: false })];
    queueBedClears(slots, lanes, readyAfter);
    ok(slots[1].est_end === t(9, 5) && slots[1].misses_deadline === true, "S6: a copy pushed past its deadline by the queue now says so");
    ok(/queueBedClears\(slots, lanes, readyAfter\);/.test(dispatch) && dispatch.indexOf("queueBedClears(slots, lanes, readyAfter);") < dispatch.indexOf("} // end fluid placement"),
      "S6: plan() runs the pass once after fluid placement (a locked plan is held still)");
    ok(/s\.why\.bed_clear \? "\. " \+ s\.why\.bed_clear/.test(dui), "S6: the Why-here line shows the queued bed clear");
  }

  // ---- F8: config.json schema on load ----
  {
    const { spawn } = require("child_process"), net = require("net"), os = require("os");
    const freePort = () => new Promise(r => { const sv = net.createServer(); sv.listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
    // Boot a Hub on its own state dir and port; resolve { code, log, up } once
    // it answers /api/version or exits.
    const boot = async (cfgText, extraEnv) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-f8-"));
      fs.writeFileSync(path.join(dir, "config.json"), cfgText);
      const port = await freePort();
      const ch = spawn(process.execPath, [path.join(REPO, "server.js")], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, U1HUB_DIR: dir, U1HUB_PORT: String(port), U1HUB_POLL_MS: "60000", ...(extraEnv || {}) } });
      let log = ""; ch.stdout.on("data", d => log += d); ch.stderr.on("data", d => log += d);
      let up = false, body = null;
      for (let i = 0; i < 80 && ch.exitCode === null; i++) {
        await new Promise(r => setTimeout(r, 250));
        try { const r = await fetch("http://127.0.0.1:" + port + "/api/version"); if (r.ok) { up = true; body = await r.json(); break; } } catch {}
      }
      const code = ch.exitCode;
      if (ch.exitCode === null) { ch.kill("SIGTERM"); await new Promise(r => { ch.on("exit", r); setTimeout(r, 2000); }); }
      await new Promise(r => setTimeout(r, 100));
      const cfgAfter = (() => { try { return fs.readFileSync(path.join(dir, "config.json"), "utf8"); } catch { return null; } })();
      fs.rmSync(dir, { recursive: true, force: true });
      return { code, log, up, body, port, cfgAfter };
    };
    const base = { gcodeFolder: "./gcode", printers: [{ name: "A", url: "http://127.0.0.1:1" }] };
    let r = await boot("\uFEFF" + JSON.stringify(base));
    ok(r.up && /UTF-8 BOM/.test(r.log) && /Printers: A/.test(r.log), "F8: a config.json with a UTF-8 BOM (PowerShell 5) boots with its printers and warns about the BOM", r.log.slice(-300));
    r = await boot(JSON.stringify({ ...base, port: "4545" }));
    ok(!r.up && r.code === 1 && /config\.json: "port" must be a number, got string/.test(r.log), "F8: a wrong type exits 1 and names the key and the expected type", { code: r.code, log: r.log.slice(-300) });
    r = await boot(JSON.stringify({ ...base, printers: {} }));
    ok(!r.up && r.code === 1 && /"printers" must be an array, got object/.test(r.log), "F8: ...for an array key too", { code: r.code, log: r.log.slice(-200) });
    r = await boot(JSON.stringify({ ...base, gcodeFolderr: "./gcode", nonsense: 1 }));
    ok(r.up && /config\.json: unknown key "gcodeFolderr"/.test(r.log) && /unknown key "nonsense"/.test(r.log), "F8: an unknown key warns and the Hub boots", r.log.slice(-300));
    ok(r.cfgAfter && JSON.parse(r.cfgAfter).nonsense === 1, "F8: ...and the unknown key is carried through, not dropped");
    r = await boot(JSON.stringify({ ...base, tip: null, models: { folder: "my-models" }, timelapse: { saveDir: "" } }));
    ok(r.up && !/config\.json:/.test(r.log), "F8: null for an optional block and a blank path are fine (no warning, no error)", r.log.slice(-200));
    // Relative paths resolve against the base dir, in memory, at load.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "u1hub-f8v-"));
    try {
      const fakeHub = { BASE_DIR: dir2, CONFIG_PATH: path.join(dir2, "config.json"), DEFAULT_CFG: {}, IS_PKG: false, hublog: () => {} };
      fs.writeFileSync(fakeHub.CONFIG_PATH, "{}");
      require(path.join(REPO, "core", "config.js"))(fakeHub);
      const cfg = { models: { folder: "lib/models" }, slicer: { srcFolder: "3mf", template: path.resolve(dir2, "abs.3mf") }, timelapse: { saveDir: "tl" }, backupDir: "bk" };
      const v = fakeHub.validateConfig(cfg);
      ok(v.errors.length === 0 && cfg.models.folder === path.resolve(dir2, "lib/models") && cfg.slicer.srcFolder === path.resolve(dir2, "3mf") && cfg.slicer.template === path.resolve(dir2, "abs.3mf") && cfg.timelapse.saveDir === path.resolve(dir2, "tl") && cfg.backupDir === path.resolve(dir2, "bk"),
        "F8: models.folder, slicer paths, the timelapse folder and backupDir resolve against the base dir; absolute ones are left alone", cfg);
      const v2 = fakeHub.validateConfig({ features: [], slicer: "orca", port: 4545 });
      ok(v2.errors.length === 2 && /"features" must be an object, got array/.test(v2.errors[0]) && /"slicer" must be an object, got string/.test(v2.errors[1]), "F8: validateConfig names every wrong-typed key", v2.errors);
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  }

  // ---- H16 ----
  ok(/folder: path\.resolve\(ctx\.baseDir, String\(c\.folder \|\| sl\.srcFolder \|\| "models"\)\)/.test(read("modules/models.js")),
    "H16: models.folder resolves against ctx.baseDir, not process.cwd()");
};

if (require.main === module) {
  let pass = 0, fail = 0;
  module.exports((c, n, d) => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + (d !== undefined ? "  -> " + JSON.stringify(d) : "")); } })
    .then(() => { console.log(pass + " passed, " + fail + " failed"); process.exit(fail ? 1 : 0); })
    .catch(e => { console.error(e); process.exit(1); });
}
