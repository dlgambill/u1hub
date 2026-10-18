// core/health.js - /healthz and nightly state backups (F9, 2.45)
//
//   GET /healthz   200 {ok:true, version, printers, uptime}  once the server
//                  listens; 503 {ok:false, booting:true} before that. Outside
//                  the sign-in gate (auth.js allowlists it) so a service
//                  watchdog or an uptime monitor can poll it with no cookie.
//                  It answers from memory - no disk, no printer - so a slow
//                  share can never make the Hub look down.
//
//   Backups        every night at 03:00 local, and once at startup when today
//                  has none, the state files that are hard to rebuild
//                  (dispatch.json, spools.json, config.json, auth.json,
//                  estimates.json, models-index.json, whichever exist) are
//                  copied into <baseDir>/backups/YYYY-MM-DD/. The newest 7
//                  days are kept. config.json `backupDir` overrides the
//                  folder; the default is beside the state, never on the
//                  library share, because a backup that lives on the thing
//                  that fails is not a backup.
const fs = require("fs");
const path = require("path");

const STATE_FILES = ["dispatch.json", "spools.json", "config.json", "auth.json", "estimates.json", "models-index.json"];
const KEEP_DAYS = 7;
const dayKey = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

// Copies the state files for `day` into dir/<day>/ and prunes to KEEP_DAYS.
// Returns { dir, day, copied: [names], pruned: [days] }. Pure function of its
// arguments so the harness can run it against a temp state dir.
function runBackup(baseDir, backupDir, day = dayKey()) {
  const dir = path.resolve(backupDir || path.join(baseDir, "backups"));
  const dest = path.join(dir, day);
  fs.mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const f of STATE_FILES) {
    const src = path.join(baseDir, f);
    if (!fs.existsSync(src)) continue;
    // temp-then-rename, so a half-written copy never sits under a final name
    const tmp = path.join(dest, f + ".tmp");
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, path.join(dest, f));
    copied.push(f);
  }
  const days = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map(e => e.name).sort();
  const pruned = [];
  while (days.length > KEEP_DAYS) {
    const old = days.shift();
    try { fs.rmSync(path.join(dir, old), { recursive: true, force: true }); pruned.push(old); } catch {}
  }
  return { dir, day, copied, pruned };
}

function hasBackupForToday(baseDir, backupDir) {
  const dir = path.resolve(backupDir || path.join(baseDir, "backups"));
  try { return fs.readdirSync(path.join(dir, dayKey())).length > 0; } catch { return false; }
}

// ms until the next 03:00 local time
function msUntilThree(now = new Date()) {
  const t = new Date(now); t.setHours(3, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t - now;
}

module.exports = function (hub) {
  const { app, BASE_DIR, hublog } = hub;
  let LISTENING = false;
  const started = Date.now();

  app.get("/healthz", (req, res) => {
    if (!LISTENING) return res.status(503).json({ ok: false, booting: true });
    res.json({ ok: true, version: hub.VERSION, printers: (hub.PRINTERS || []).length, uptime: Math.round((Date.now() - started) / 1000) });
  });

  const backupDir = () => (hub.CFG && typeof hub.CFG.backupDir === "string" && hub.CFG.backupDir.trim()) ? hub.CFG.backupDir.trim() : null;
  function backupNow(reason) {
    try {
      const r = runBackup(BASE_DIR, backupDir());
      hublog("info", "backup: " + reason + " - " + r.copied.length + " file" + (r.copied.length === 1 ? "" : "s") + " to " + path.join(r.dir, r.day) + (r.pruned.length ? ", pruned " + r.pruned.join(", ") : ""));
    } catch (e) { hublog("warn", "backup: " + reason + " failed - " + e.message); }
  }
  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { backupNow("nightly"); schedule(); }, msUntilThree());
    if (timer.unref) timer.unref();
  }

  // Called by server.js once app.listen has fired.
  function markListening() {
    LISTENING = true;
    if (process.env.U1HUB_NO_BACKUP) return;     // the harness boots dozens of Hubs; no backup folders in temp state dirs
    if (!hasBackupForToday(BASE_DIR, backupDir())) setTimeout(() => backupNow("startup"), 2000).unref();
    schedule();
  }

  Object.assign(hub, { markListening, runBackup, backupNow });
};
module.exports.runBackup = runBackup;
module.exports.msUntilThree = msUntilThree;
module.exports.STATE_FILES = STATE_FILES;
module.exports.KEEP_DAYS = KEEP_DAYS;
