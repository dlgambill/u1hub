// core/util.js - the small helpers every core file and module used to carry
// its own copy of (H19, 2.45). Pure functions and one filesystem idiom; no
// hub state, so a module, a script and the harness can all require it.
//
//   stripSlash(u)        - a URL or path without its trailing slashes
//   printerUrl(p)        - a printer record's base URL, trailing slashes off
//   printerWsUrl(p)      - the same printer's Moonraker WebSocket URL
//   atomicWrite(f, text) - write temp-then-rename (the H15 shape); throws on
//                          failure with the temp file cleaned up, so a caller
//                          with a fallback (dispatch, timelapse, updates) can
//                          still latch it
//   isoWeekKey(d)        - "2026-W35", ISO 8601, local time
//   nameMatcher(q)       - substring / * ? / -word search predicate (the
//                          server twin of app.js's)
//   grabFrame(base, ms)  - one chamber-camera frame from a printer, or null
"use strict";

const fs = require("fs");

const stripSlash = u => String(u == null ? "" : u).replace(/\/+$/, "");

const printerUrl = p => stripSlash(p && p.url);

const printerWsUrl = p => printerUrl(p).replace(/^http/, "ws") + "/websocket";

// Write `text` to `file` by way of `file + ".tmp"` and a rename, so a crash
// mid-write can never leave a half-written file behind. On failure the temp
// file is removed and the error is rethrown: whether to fall back to a
// direct write (some SMB shares refuse rename-over-existing) is the caller's
// decision, and it must never be silent.
function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

// ISO week key, local time (Thursday-anchored per ISO 8601). Takes a Date or
// a millisecond timestamp.
function isoWeekKey(d) {
  const dt = new Date(d instanceof Date ? d.getTime() : d); dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
  const jan4 = new Date(dt.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return dt.getFullYear() + "-W" + String(wk).padStart(2, "0");
}

// Server twin of app.js nameMatcher (v2.24): plain substring, * and ?, -word.
function nameMatcher(q) {
  const terms = String(q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  const tests = terms.map(t => {
    let neg = false;
    if (t.length > 1 && t[0] === "-") { neg = true; t = t.slice(1); }
    let fn;
    if (/[*?]/.test(t)) {
      const re = new RegExp("^" + t.split(/([*?])/).map(p => p === "*" ? ".*" : p === "?" ? "." : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("") + "$");
      fn = n => re.test(n);
    } else fn = n => n.includes(t);
    return neg ? n => !fn(n) : fn;
  });
  return name => { const n = String(name || "").toLowerCase(); return tests.every(fn => fn(n)); };
}

// One frame of the Snapmaker camera plugin's monitor.jpg from a printer base
// URL. Resolves { buf, lastModified, date } for a valid JPEG, null for a
// miss, a bad body or a timeout - never throws. The headers let a caller
// (timelapse) tell a new picture from the last one the camera left on disk.
async function grabFrame(base, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs || 5000);
  try {
    const r = await fetch(stripSlash(base) + "/server/files/camera/monitor.jpg", { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(to);
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (!(b.length > 2 && b[0] === 0xff && b[1] === 0xd8)) return null; // valid JPEG SOI
    return { buf: b, lastModified: r.headers.get("last-modified"), date: r.headers.get("date") };
  } catch { clearTimeout(to); return null; }
}

module.exports = { stripSlash, printerUrl, printerWsUrl, atomicWrite, isoWeekKey, nameMatcher, grabFrame };
