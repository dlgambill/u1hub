// parser.js — reads a sliced Snapmaker U1 gcode file and reports the FILAMENT
// the print actually needs.
//
// Key facts learned from real U1 gcode:
//  * The body uses T<n> where n is a LOGICAL palette index (0..N-1), NOT a
//    physical toolhead. The U1 has 4 physical heads and maps logical->physical
//    at print start (RFID match / Orca preprocessing).
//  * So the right answer is "which palette colors does this print use", and the
//    machine decides which of its 4 heads each lands in.

const SKIP = new Set([
  "G0","G1","G2","G3","G4","G17","G28","G29","G90","G91","G92",
  "M82","M83","M84","M104","M105","M106","M107","M109","M140","M190",
  "M201","M203","M204","M205","M220","M221","M73","M17","M18","M400","M412","M569","M593",
  "SET_VELOCITY_LIMIT","EXCLUDE_OBJECT_START","EXCLUDE_OBJECT_END"
]);

function parseConfig(text) {
  const cfg = {};
  const cfgLines = [];
  const reEq = /^\s*;\s*([A-Za-z0-9_ %\[\]\(\)\/.-]+?)\s*=\s*(.*?)\s*$/;
  const interesting = /filament_colou?r|filament_type|filament_vendor|_map|mapping|initial_tool|initial_extruder/i;
  const noise = /WIPE_START|WIPE_END|Change Tool|^[;\s]*[A-Za-z0-9+\/]{40,}={0,2}$/;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(reEq);
    if (m) cfg[m[1].trim().toLowerCase()] = m[2];
    const t = line.trim();
    if (t.startsWith(";") && interesting.test(t) && !noise.test(t) && cfgLines.length < 50) {
      cfgLines.push(t);
    }
  }
  return { cfg, cfgLines };
}

function splitAligned(s) {
  if (s == null) return [];
  let parts;
  if (s.includes(";")) parts = s.split(";");
  else if (s.split(",").length > 1) parts = s.split(",");
  else parts = [s];
  return parts.map(x => x.trim());
}
function firstKey(cfg, keys) { for (const k of keys) if (k in cfg) return cfg[k]; return undefined; }
function normHex(c) {
  if (!c) return null;
  let h = c.trim(); if (!h) return null;
  if (h[0] !== "#") h = "#" + h;
  if (/^#[0-9a-fA-F]{8}$/.test(h)) h = h.slice(0, 7);
  if (/^#[0-9a-fA-F]{6}$/.test(h) || /^#[0-9a-fA-F]{3}$/.test(h)) return h.toUpperCase();
  return null;
}

function scanBody(text) {
  const used = new Set(); let any = false; const hist = {};
  for (const line of text.split(/\r?\n/)) {
    const code = line.split(";")[0].trim();
    if (!code) continue;
    const tok = code.split(/\s+/)[0];
    const m = tok.match(/^T(\d+)$/);
    if (m) { used.add(parseInt(m[1], 10)); any = true; }
    if (!SKIP.has(tok)) hist[tok] = (hist[tok] || 0) + 1;
  }
  const cmdHist = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([k, v]) => String(v).padStart(7) + "  " + k);
  return { used, any, cmdHist };
}

function parseGcodeMap(text, opts = {}) {
  const { cfg, cfgLines } = parseConfig(text);

  const colours = splitAligned(firstKey(cfg, ["filament_colour","filament_color","extruder_colour","extruder_color"]));
  const types   = splitAligned(firstKey(cfg, ["filament_type"]));
  const vendors = splitAligned(firstKey(cfg, ["filament_vendor"]));
  const weights = splitAligned(firstKey(cfg, ["filament used [g]","filament_used_g","filament used [grams]"]));

  // Prefer per-colour weights to decide what's used (a 0 means that colour isn't
  // printed) — this avoids scanning the huge body. Only fall back to a body
  // T#-scan if weights aren't present AND we were given the full file.
  const wNums = weights.map(w => parseFloat(w));
  const haveWeights = wNums.some(n => !isNaN(n));
  let used = new Set(), any = false, cmdHist = [];
  if (haveWeights) {
    wNums.forEach((n, i) => { if (!isNaN(n) && n > 0) { used.add(i); any = true; } });
  } else if (opts.scanBody) {
    ({ used, any, cmdHist } = scanBody(text));
  }

  const paletteCount = Math.max(colours.length, types.length, any ? Math.max(...used) + 1 : 0, 1);

  const palette = [];
  for (let i = 0; i < paletteCount; i++) {
    const hex = normHex(colours[i]);
    const type = (types[i] || "").trim();
    const vendor = (vendors[i] || "").trim();
    const wt = (weights[i] || "").trim();
    const present = !!(hex || type);
    const isUsed = any ? used.has(i) : present;
    palette.push({ i, hex, type, vendor, wt, present, used: isUsed });
  }

  const usedIdx = palette.filter(s => s.used).map(s => s.i);

  const ptime = firstKey(cfg, ["estimated printing time (normal mode)","model printing time","total estimated time","estimated printing time"]);
  let totalWt = 0, haveWt = false;
  for (const w of weights) { const n = parseFloat(w); if (!isNaN(n)) { totalWt += n; haveWt = true; } }
  const meta = [];
  if (ptime) meta.push(ptime.trim());
  if (haveWt) meta.push(totalWt.toFixed(1) + " g");

  const keys = []
    .concat(["=== logical filaments used ===", any ? usedIdx.join(", ") : "(could not determine)", ""])
    .concat(["=== filament / mapping config lines ===", ...(cfgLines.length ? cfgLines : ["(none captured)"]), ""])
    .concat(cmdHist.length ? ["=== top commands (count  token) ===", ...cmdHist] : []);

  return {
    palette, usedIdx, paletteCount,
    physicalHeads: 4,
    meta, anyTC: any, noColors: !colours.length,
    keys, allKeys: Object.keys(cfg)
  };
}

module.exports = { parseGcodeMap };
