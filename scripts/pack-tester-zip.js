// Builds a source zip for a beta tester from the STAGING tree (X:), using an
// explicit allowlist: the files git tracks in the clone, plus the v2.23 core
// split, minus internal notes, CI, and bridge-only helper scripts. Nothing
// under gcode/ except its README, no state files, no config.json, no logs.
// Every staged file is then scanned for secret-looking strings before the
// zip is written; a hit aborts the build.
//   node scripts\pack-tester-zip.js  -> %TEMP%\u1hub-tester\U1-Print-Hub-<ver>-source.zip
"use strict";
const fs = require("fs"), path = require("path"), cp = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const CLONE = "C:\\Users\\Danny\\code\\u1-print-hub";
const VER = require(path.join(ROOT, "package.json")).version;

const tracked = cp.execSync("git ls-files", { cwd: CLONE, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const extra = [
  "core/log.js", "core/config.js", "core/records.js", "core/app.js", "core/library.js",
  "core/print.js", "core/fleet.js", "core/telemetry.js", "core/thumbs.js", "core/filament.js",
  "core/network.js", "core/settings.js", "core/modules.js", "public/app.js",
];
const DROP = [
  /^\.github\//, /^CLAUDE\.md$/, /^MISTAKES\.md$/, /^HANDOFF\.md$/, /^share-posts\.md$/,
  /^scripts\/(?!refresh-filament-db\.js$)/,          // bridge/dev helpers; keep the one npm uses
  /^capture-proxy\.js$/,
];
const NEVER = [
  /(^|\/)\.env/i, /^config\.json$/, /^auth\.json$/, /^tunnel\.json$/, /^spools\.json$/, /^slots\.json$/,
  /^dispatch\.json/, /^resources\.json$/, /^queue\.json$/, /^printlog\.json$/, /^update-state\.json/,
  /\.log$/i, /\.exe$/i, /^cloudflared/, /^gcode\/.*\.(gcode|gco|g)$/i, /^thumbs\//, /^node_modules\//, /^dist\//,
];
const files = [...new Set([...tracked, ...extra])]
  .filter(f => !DROP.some(r => r.test(f)))
  .filter(f => { if (NEVER.some(r => r.test(f))) { console.log("REFUSED (never ship): " + f); return false; } return true; })
  .filter(f => { const ok = fs.existsSync(path.join(ROOT, f)); if (!ok) console.log("missing on X:, skipped: " + f); return ok; });

// Secret scan: anything that looks like a credential aborts the build.
const SECRET = [
  /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /sk-[A-Za-z0-9_-]{20,}/, /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  /https?:\/\/[^\s"']*:[^\s"'@]{6,}@/,                   // basic-auth URLs
];
const TEXT = /\.(js|json|md|txt|html|css|yml|yaml|sh|bat|cmd|dockerignore|gitignore)$/i;
let hits = 0;
for (const f of files) {
  if (!TEXT.test(f) && !/^\.(docker|git)ignore$/.test(f)) continue;
  const src = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);
  src.forEach((line, i) => {
    for (const r of SECRET) { const m = r.exec(line); if (m) { hits++; console.log("SECRET? " + f + ":" + (i + 1) + "  " + m[0].slice(0, 12) + "..."); } }
  });
}
if (hits) { console.log("\nABORT: " + hits + " secret-looking line(s). Nothing written."); process.exit(1); }

const OUT = path.join(process.env.TEMP, "u1hub-tester");
const STAGE = path.join(OUT, "U1-Print-Hub-" + VER);
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of files) {
  const dst = path.join(STAGE, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), dst);
}
const zip = path.join(OUT, "U1-Print-Hub-" + VER + "-source.zip");
// bsdtar (ships with Windows 10+): Compress-Archive silently drops dotfiles.
cp.execSync(`tar -a -cf "${zip}" -C "${OUT}" "${path.basename(STAGE)}"`);
const bytes = fs.statSync(zip).size;
console.log("\n" + files.length + " files -> " + zip + " (" + (bytes / 1024 / 1024).toFixed(2) + " MB)");
console.log("top-level: " + [...new Set(files.map(f => f.split("/")[0]))].sort().join(", "));
