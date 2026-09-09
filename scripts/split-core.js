// scripts/split-core.js — cut server.js into core/*.js along declaration
// boundaries, behavior-preserving. Files load in ORIGINAL order through one
// shared `hub` object; mutable globals become hub.<NAME>; everything else is
// destructured from hub at the top of each file. Dry run by default.
//   node scripts/split-core.js          # report
//   node scripts/split-core.js --apply  # write core/*.js + new server.js
"use strict";
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
// Re-runnable: once applied, the pre-split original is the input, not the new stub.
const BACKUP = path.join(ROOT, "scripts", "_server.pre-split.js");
const SRC = fs.readFileSync(fs.existsSync(BACKUP) ? BACKUP : path.join(ROOT, "server.js"), "utf8");
const L = SRC.split(/\r?\n/);
const APPLY = process.argv.includes("--apply");

// ---- partition: first-line ranges -> file (original order preserved) -------
const PART = [
  ["__pre",      1,   22,  ""],
  ["log",       23,   79,  "ring-buffer logger, install paths, default config"],
  ["config",    80,  237,  "printer types, config load/save, feature flags, capability detection, PORT"],
  ["records",  238,  389,  "what the Hub remembers: print log, filament memory, queue, and the print-start watcher"],
  ["app",      390,  498,  "the Express app: middleware, auth, tunnel, page server, static files"],
  ["library",  499, 1002,  "types API, library files, printer files, queue routes, gcode color map, palette index"],
  ["print",   1003, 1243,  "the print pipeline: color rewrite, upload, /api/print, print control, exclude-object"],
  ["fleet",   1244, 1614,  "what the farm is doing: head decode, probe, realtime websocket, disk poll, snapshot, SSE"],
  ["telemetry",1615,1771,  "farm stats, history, temperature trends, per-printer stats, bed temp"],
  ["thumbs",  1772, 1877,  "gcode thumbnails"],
  ["filament",1878, 1968,  "filament color + material write (hardware-verified gcode)"],
  ["network", 1969, 2008,  "network inventory, diagnostics bundle, subnet discovery, debug websocket"],
  ["settings",2009, 2039,  "public config view, /api/config, /api/version"],
  ["network", 2040, 2129,  ""],
  ["settings",2130, 2190,  ""],
  ["network", 2191, 2357,  ""],
  ["modules", 2358, 2462,  "feature-module loader and the ctx modules receive"],
  ["__tail",  2463, 1e9,   ""]
];
const FILE_ORDER = ["log","config","records","app","library","print","fleet","telemetry","thumbs","filament","network","settings","modules"];
const DESC = {}; for (const [f,,,d] of PART) if (d) DESC[f] = d;
const fileOf = ln => { for (const [f,a,b] of PART) if (ln >= a && ln <= b) return f; return null; };

// ---- chunks: column-0 statement starts, leading comments attached ----------
const starts = [];
L.forEach((l, i) => { if (/^[A-Za-z_$(\[]/.test(l)) starts.push(i); });
// leading comments (incl. `// ----` section headers) travel with the statement they precede
function begin(si) { let b = si; while (b > 0 && /^(\s*|\s*\/\/.*)$/.test(L[b - 1])) b--; return b; }
const chunks = starts.map((s, k) => ({ start: s, begin: begin(s), end: (k + 1 < starts.length ? begin(starts[k + 1]) : L.length) - 1 }));
chunks.forEach(c => { c.file = fileOf(c.start + 1); c.text = L.slice(c.begin, c.end + 1).join("\n"); });
// everything before the first core chunk (header comment, VERSION, requires) stays verbatim in server.js
const PRE_END = chunks.find(c => c.file !== "__pre").begin;   // lines [0, PRE_END) are the preamble
const missing = chunks.filter(c => !c.file);
if (missing.length) { console.error("UNMAPPED chunks at lines: " + missing.map(c => c.start + 1).join(", ")); process.exit(1); }

// ---- top-level names --------------------------------------------------------
const NODE_MODS = { crypto: 'const crypto = require("crypto");', express: 'const express = require("express");', fs: 'const fs = require("fs");',
  http: 'const http = require("http");', path: 'const path = require("path");', os: 'const os = require("os");',
  Transform: 'const { Transform } = require("stream");', parseGcodeMap: 'const { parseGcodeMap } = require("../parser");' };
const names = new Map();   // name -> { file, kind, line }
for (const c of chunks) {
  const l = L[c.start];
  let m = /^(const|let|var|function|async function|class)\s+(.*)$/.exec(l);
  if (!m) continue;
  const kind = m[1];
  if (/^(function|async function|class)$/.test(kind)) { const n = /^([A-Za-z_$][\w$]*)/.exec(m[2]); if (n) names.set(n[1], { file: c.file, kind, line: c.start + 1 }); continue; }
  // const/let/var: may declare several (let CFG, FOLDER, PRINTERS, TYPES;) or destructure.
  // Split on commas at bracket depth 0 ONLY — `const DEFAULT_CFG = { port: 4545, ... }`
  // declares one name, not four.
  const decl = m[2].replace(/\/\/.*$/, "");
  if (/^[{[]/.test(decl)) continue;                       // destructured requires: handled as node mods
  const parts = []; let depth = 0, cur = "", q = null;
  for (let k = 0; k < decl.length; k++) {
    const ch = decl[k];
    if (q) { cur += ch; if (ch === "\\") { cur += decl[++k] || ""; } else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; cur += ch; continue; }
    if ("([{".includes(ch)) depth++; else if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  for (const part of parts) { const n = /^\s*([A-Za-z_$][\w$]*)/.exec(part); if (n && !NODE_MODS[n[1]]) names.set(n[1], { file: c.file, kind, line: c.start + 1 }); }
}
names.set("VERSION", { file: "__pre", kind: "const", line: 6 });

// ---- identifier scanner: code only (skips comments, strings; sees ${} in templates)
function scan(text, fn) {
  // fn(name, idx, prevCh, nextCh) -> replacement string or null
  let out = "", i = 0, n = text.length;
  const isId = ch => /[A-Za-z0-9_$]/.test(ch);
  while (i < n) {
    const ch = text[i], nx = text[i + 1];
    if (ch === "/" && nx === "/") { const j = text.indexOf("\n", i); const e = j < 0 ? n : j; out += text.slice(i, e); i = e; continue; }
    if (ch === "/" && nx === "*") { const j = text.indexOf("*/", i + 2); const e = j < 0 ? n : j + 2; out += text.slice(i, e); i = e; continue; }
    if (ch === "'" || ch === '"') { let j = i + 1; while (j < n && text[j] !== ch) { if (text[j] === "\\") j++; j++; } out += text.slice(i, j + 1); i = j + 1; continue; }
    if (ch === "`") { // template: copy literal parts, scan ${...} parts
      let j = i + 1; out += "`";
      while (j < n && text[j] !== "`") {
        if (text[j] === "\\") { out += text.slice(j, j + 2); j += 2; continue; }
        if (text[j] === "$" && text[j + 1] === "{") {
          let depth = 1, k = j + 2; while (k < n && depth) { if (text[k] === "{") depth++; else if (text[k] === "}") depth--; k++; }
          out += "${" + scan(text.slice(j + 2, k - 1), fn) + "}"; j = k; continue;
        }
        out += text[j]; j++;
      }
      out += "`"; i = j + 1; continue;
    }
    if (ch === "/" && isRegexStart(text, i)) { let j = i + 1, cls = false; while (j < n && (cls || text[j] !== "/")) { if (text[j] === "\\") j++; else if (text[j] === "[") cls = true; else if (text[j] === "]") cls = false; j++; } j++; while (j < n && /[gimsuy]/.test(text[j])) j++; out += text.slice(i, j); i = j; continue; }
    if (isId(ch) && !(i > 0 && isId(text[i - 1]))) {
      let j = i; while (j < n && isId(text[j])) j++;
      const word = text.slice(i, j);
      let p = i - 1; while (p >= 0 && /[ \t]/.test(text[p])) p--;
      let q = j; while (q < n && /[ \t]/.test(text[q])) q++;
      const rep = fn(word, text[p] || "", text[q] || "", text, p, q);
      out += rep == null ? word : rep; i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}
function isRegexStart(text, i) { // crude: a "/" is a regex if the previous significant char can't end an expression
  let p = i - 1; while (p >= 0 && /[ \t]/.test(text[p])) p--;
  if (p < 0) return true; const c = text[p];
  if (/[)\]}\w$]/.test(c)) { // could be division... unless preceded by a keyword like return/typeof
    const w = /([A-Za-z_$]+)$/.exec(text.slice(Math.max(0, p - 10), p + 1));
    return !!(w && /^(return|typeof|case|in|of|delete|void|throw|else|do)$/.test(w[1]));
  }
  return true;
}

// ---- per-file analysis ------------------------------------------------------
const byFile = {}; for (const c of chunks) (byFile[c.file] = byFile[c.file] || []).push(c);
const fileIdx = f => f === "__pre" ? -1 : f === "__tail" ? 99 : FILE_ORDER.indexOf(f);
// `a.NAME` is a property access and never rewritten; `...NAME` is a spread and IS a reference.
const isMember = (s, p) => s[p] === "." && !(s[p - 1] === "." && s[p - 2] === ".");
const refsOf = text => { const s = new Set(); scan(text, (w, pc, nc, src, p) => { if (!isMember(src, p) && names.has(w)) s.add(w); return null; }); return s; };
const declaredWhere = {}; for (const [nm, d] of names) declaredWhere[nm] = d.file;
// which names are referenced from a file other than their home?
const crossUsed = new Set();
for (const f of Object.keys(byFile)) { const refs = refsOf(byFile[f].map(c => c.text).join("\n")); for (const r of refs) if (declaredWhere[r] !== f) crossUsed.add(r); }
// mutable = let/var reassigned anywhere (not ==, =>, >=, <=, !=)
const mutable = new Set();
for (const [nm, d] of names) if (/^(let|var)$/.test(d.kind)) {
  const rx = new RegExp("(^|[^\\w$.])" + nm + "\\s*(=(?!=)|\\+=|-=|\\+\\+|--)");
  if (L.some((l, i) => i + 1 !== d.line && rx.test(l.replace(/\/\/.*$/, "")))) mutable.add(nm);
}
const shared = [...mutable].filter(n => crossUsed.has(n));    // -> hub.N everywhere
const sharedSet = new Set(shared);

// ---- rewrite one file's text -------------------------------------------------
function rewrite(text, f) {
  const fi = fileIdx(f);
  let t = scan(text, (w, pc, nc, s, p, q) => {
    if (w === "__dirname" && f !== "__tail" && !isMember(s, p)) return 'path.join(__dirname, "..")';   // core/ is one level down
    if (!names.has(w) || isMember(s, p)) return null;
    const home = declaredWhere[w], hi = fileIdx(home);
    const isKey = (pc === "{" || pc === ",") && nc === ":";
    const isShorthand = (pc === "{" || pc === ",") && (nc === "," || nc === "}");
    if (isKey) return null;
    if (sharedSet.has(w)) return isShorthand ? w + ": hub." + w : "hub." + w;
    if (home === f) return null;                                   // own name: bare
    if (hi < fi) return null;                                      // earlier file: destructured at top
    return isShorthand ? w + ": hub." + w : "hub." + w;            // later file: through hub
  });
  if (f !== "__tail") t = t.replace(/require\("\.\//g, 'require("../');
  return t;
}
// Shared-name declarations become hub assignments. Runs on the RAW text, before
// identifier rewriting: `let CFG, FOLDER, PRINTERS, TYPES;` -> a note (hub
// properties start undefined, exactly as the hoisted lets did), and
// `let FEATURES = {...}` / `var FARM_READY = false` lose their keyword so the
// rewrite turns them into `hub.FEATURES = {...}` / `hub.FARM_READY = false`.
function fixDecl(text) {
  return text.replace(/^(let|var)\s+([^=;\n]+);[ \t]*(\/\/.*)?$/mg, (m, k, list, cmt) => {
      const ns = list.split(",").map(x => x.trim()); if (!ns.every(n => sharedSet.has(n))) return m;
      return "/* shared state lives on hub: " + ns.join(", ") + " */" + (cmt ? "  " + cmt : ""); })
    .replace(/^(let|var)\s+([A-Za-z_$][\w$]*)(\s*=)/mg, (m, k, n, eq) => sharedSet.has(n) ? n + eq : m);
}

// ---- report / apply ---------------------------------------------------------
console.log("shared mutable state (hub.X everywhere): " + shared.join(", "));
const outFiles = {};
const report = [];
for (const f of [...FILE_ORDER, "__tail"]) {
  const cs = byFile[f] || [];
  const raw = cs.map(c => c.text).join("\n\n");
  const refs = refsOf(raw);
  const own = new Set(); for (const [nm, d] of names) if (d.file === f) own.add(nm);
  const fi = fileIdx(f);
  const destructure = [...refs].filter(r => !own.has(r) && !sharedSet.has(r) && fileIdx(declaredWhere[r]) < fi
                                       && !(f === "__tail" && declaredWhere[r] === "__pre")).sort();   // tail already has VERSION in scope
  const viaHub = [...refs].filter(r => !own.has(r) && !sharedSet.has(r) && fileIdx(declaredWhere[r]) > fi).sort();
  const exports_ = [...own].filter(n => crossUsed.has(n) && !sharedSet.has(n)).sort();
  const mods = Object.keys(NODE_MODS).filter(m => new RegExp("(^|[^\\w$.])" + m + "(?![\\w$])").test(raw.replace(/\/\/.*$/mg, "")));
  let body = rewrite(fixDecl(raw), f);
  if (f !== "__tail" && /path\.join\(__dirname/.test(body) && !mods.includes("path")) mods.push("path");
  report.push(`\n== core/${f}.js  (${cs.length} chunks, ${raw.split("\n").length} lines)\n   requires: ${mods.join(", ") || "-"}\n   from hub: ${destructure.join(", ") || "-"}\n   via hub (LATER file!): ${viaHub.join(", ") || "-"}\n   exports:  ${exports_.join(", ") || "-"}`);
  if (f === "__tail") { outFiles.__tail = { body, destructure, mods }; continue; }
  const head = `// core/${f}.js — ${DESC[f] || ""}\n// Split out of server.js (v2.23). Loads in the original order through the\n// shared \`hub\`; see server.js for the sequence. Behavior-preserving move.\n` +
    mods.map(m => NODE_MODS[m]).join("\n") + (mods.length ? "\n" : "") +
    `\nmodule.exports = function (hub) {\n` +
    (destructure.length ? `const { ${destructure.join(", ")} } = hub;\n\n` : "\n");
  const tail = (exports_.length ? `\n\nObject.assign(hub, { ${exports_.join(", ")} });` : "") + `\n};\n`;
  outFiles[f] = head + body + tail;
}
// server.js
const tailInfo = outFiles.__tail;
// the preamble keeps only the requires the tail still uses (each core file requires its own)
const pre = L.slice(0, PRE_END).filter(l => {
  const m = /^const (?:\{\s*(\w+)\s*\}|(\w+)) = require\(/.exec(l);
  if (!m) return true;
  const name = m[1] || m[2];
  return new RegExp("(^|[^\\w$.])" + name + "(?![\\w$])").test(tailInfo.body.replace(/\/\/.*$/mg, ""));
}).join("\n");
const serverJs = pre + "\n" +
  `// v2.23: the core is split into core/*.js. Every file receives the same \`hub\`\n// object and runs in this exact order — the order the code had in the old\n// single file, which load-time statements (loadConfig, middleware, listen)\n// depend on. Shared mutable state (${shared.join(", ")}) lives on hub.\n` +
  `const hub = { VERSION };\n` +
  FILE_ORDER.map(f => `require("./core/${f}.js")(hub);`).join("\n") + "\n" +
  (tailInfo.destructure.length ? `const { ${tailInfo.destructure.join(", ")} } = hub;\n` : "") +
  "\n" + tailInfo.body + "\n";
console.log(report.join("\n"));
// shadow check: inner declarations / params named like a top-level name
const shadows = [];
L.forEach((l, i) => { if (/^[A-Za-z_$]/.test(l)) return; const m = /\b(const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(l); if (m && names.has(m[2])) shadows.push((i + 1) + ": " + l.trim().slice(0, 90)); });
console.log("\nINNER DECLARATIONS SHADOWING A TOP-LEVEL NAME (review):\n" + (shadows.join("\n") || "  none"));
if (!APPLY) { console.log("\ndry run — pass --apply"); process.exit(0); }
fs.mkdirSync(path.join(ROOT, "core"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "scripts", "_server.pre-split.js"), SRC);
for (const f of FILE_ORDER) fs.writeFileSync(path.join(ROOT, "core", f + ".js"), outFiles[f]);
fs.writeFileSync(path.join(ROOT, "server.js"), serverJs);
console.log("\nWROTE core/*.js and server.js (original kept at scripts/_server.pre-split.js)");
