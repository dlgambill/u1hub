#!/usr/bin/env node
// scripts/refresh-filament-db.js — regenerate the bundled FilamentColors.xyz snapshot.
//
// Pulls the full swatch database from the public REST API (no auth) and trims
// each ~3 KB record down to the 9 fields the Hub needs (~209 bytes/record,
// ~460 KB total). The maintainer explicitly asks integrators to CACHE rather
// than hit the API live — this snapshot IS that cache. Run this at build /
// release time (or let users hit "Update filament library" in Settings, which
// does the same pull server-side and stores the result next to config.json).
//
// Data © FilamentColors.xyz (Joe Kaufeld), MIT license — safe to bundle and
// redistribute. Colors are colorimeter-measured (CHNSpec DS-220), so hex/LAB
// reflect printed filament, not marketing swatches; LAB feeds CIEDE2000
// matching directly with no RGB→LAB conversion.
//
// Usage: node scripts/refresh-filament-db.js [outfile]
//        (default outfile: <repo>/filament-swatches.json)

const fs = require("fs");
const path = require("path");

const API = "https://filamentcolors.xyz/api/swatch/";
const PAGE_SIZE = 100; // API max
const DELAY_MS = 350;  // be a good neighbor between pages

// Shared with server-side refresh (rfid.js requires this module).
function trimRecord(r) {
  const ft = r.filament_type || {};
  const parent = (ft.parent_type && ft.parent_type.name) || null;
  return {
    id: r.id,
    brand: (r.manufacturer && r.manufacturer.name) || "",
    material: parent || ft.name || "",           // loose bucket ("Exotics") — keep, don't lead with it
    material_variant: ft.name || "",             // the useful label — DISPLAY THIS
    color_name: r.color_name || "",
    hex: String(r.hex_color || "").toUpperCase(),
    lab: [r.lab_l, r.lab_a, r.lab_b].map(v => (typeof v === "number" ? v : null)),
    hot_end_temp: ft.hot_end_temp || null,
    bed_temp: ft.bed_temp || null,
    color_source: "measured"                     // FilamentColors = colorimeter-measured.
    // If a second DB (e.g. OFD, community-entered hex) is ever added, tag those
    // "nominal" so Spool Match can down-weight them instead of blending blindly.
  };
}

async function pullAll(log) {
  const records = [];
  let url = API + "?page_size=" + PAGE_SIZE;
  let page = 1;
  while (url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("FilamentColors API HTTP " + r.status + " on page " + page);
    const d = await r.json();
    for (const rec of d.results || []) {
      const t = trimRecord(rec);
      if (t.hex && /^[0-9A-F]{6}$/.test(t.hex)) records.push(t);
    }
    if (log) log(`page ${page}: ${records.length}/${d.count} swatches`);
    url = d.next;
    page++;
    if (url) await new Promise(res => setTimeout(res, DELAY_MS));
  }
  return {
    source: "https://filamentcolors.xyz",
    license: "MIT (data © Joe Kaufeld / FilamentColors.xyz)",
    fetchedAt: new Date().toISOString(),
    count: records.length,
    swatches: records
  };
}

module.exports = { trimRecord, pullAll, API };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, "..", "filament-swatches.json");
  pullAll(console.log)
    .then(snap => {
      // v2.19: only write when the DATA changed.
      //
      // `fetchedAt` used to be stamped on every run, so a refresh that found
      // upstream unchanged still rewrote a 900 KB single-line file and left a
      // diff in the repo — one that looks enormous in `git diff` and contains
      // nothing but a new timestamp. That is exactly how a meaningless change
      // sits dirty in a working copy for three weeks with nobody able to say
      // what it was (this happened; see MISTAKES.md).
      //
      // fetchedAt therefore means "when this data was last actually different",
      // which is the useful reading of it. A run that changes nothing says so
      // on stdout and leaves the file alone.
      let prev = null;
      try { prev = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
      const same = prev
        && prev.count === snap.count
        && JSON.stringify(prev.swatches) === JSON.stringify(snap.swatches);
      if (same) {
        console.log(`\nUpstream is unchanged — ${snap.count} swatches, identical to what is on disk.`);
        console.log(`Left ${out} untouched (still stamped ${prev.fetchedAt}).`);
        console.log(`Checked at ${snap.fetchedAt}.`);
        return;
      }
      fs.writeFileSync(out, JSON.stringify(snap));
      const kb = (fs.statSync(out).size / 1024).toFixed(0);
      const delta = prev ? ` (was ${prev.count})` : "";
      console.log(`\nWrote ${snap.count} swatches${delta} → ${out} (${kb} KB)`);
    })
    .catch(e => { console.error("Refresh failed:", e.message); process.exit(1); });
}
