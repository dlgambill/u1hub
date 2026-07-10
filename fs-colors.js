// fs-colors.js — Full Spectrum mix planner for the U1 Print Hub.
//
// Reads a multi-color 3MF, extracts its palette, and computes the CMYW blend
// recipes ("virtual colors") needed to print it on a 4-toolhead U1 running a
// Full Spectrum OrcaSlicer fork. READ-ONLY by design: the Hub never writes or
// re-zips project files — the user enters the recipes in the slicer.
//
// ---- Verified findings this module is built on (2026-07-09, live fork tests) ----
//
// Definition storage (Neotko fork, confirmed by save/unzip + hand-edit round trip):
//   Metadata/project_settings.config -> "mixed_filament_definitions"
//   Definitions are ';'-joined. Two serializations, chosen by component count:
//     Pair  (2 comps):  A,B,1,1,P,0,g,w,m2,z0,xa0,xb0,d0,o0,uN,cm0
//                       A,B = 1-based filament indices; P = B's percent
//                       (A gets 100-P). Verified: hand-written "2,4,...,40,..m2"
//                       loaded as "F2 60%+F4 40%".
//     List  (3+ comps): 1,2,1,1,50,0,g<idx...>,w<p1/p2/...>,m0,z0,xa0,xb0,d0,o0,uN,cm0
//                       leading tokens vestigial; g = ascending concatenated
//                       indices; w percentages match g order. Verified:
//                       "g123,w20/30/50" loaded as "F1 20%+F2 30%+F3 50%".
//   List format does NOT work for pairs (tried g31 and g13 — fork fell back to
//   the leading vestigial tokens both times). Pairs must use m2.
//   Unknown flags (z0,xa0,xb0,d0,o0,cm0 and tokens 3,4,6) are emitted verbatim
//   at their observed defaults.
//
// Blend model: sRGB-space weighted average. Fitted against the fork's own
// "Mix Effect" preview swatches: exact (#BFBA62, zero error) for the 3-way
// 27/25/48 test; nearest simple model for pairs (linear-light, geometric/
// subtractive, HSV, Lab and power-curve mixing all fit worse). Also matches
// the known physical gamut limit: interleaved bright filaments can't average
// into true black or saturated darks. Swap point for a future swatch-grid
// calibration table is blendHex() below.
//
// Palette source (verified against a real 10-color Bambu Studio project):
//   Metadata/project_settings.config -> "filament_colour" (same key family in
//   Bambu Studio and the Orca forks, so one parser covers both), plus
//   Metadata/model_settings.config extruder="N" assignments (1-based into the
//   colour array) to rank colors by how many parts actually use them.
// --------------------------------------------------------------------------------

"use strict";

const zlib = require("zlib");

// ---- Minimal ZIP reader (pure Node, no deps — keeps pkg builds unchanged) ----
// 3MF is a ZIP. We only need two small text members, so: find the End Of
// Central Directory, walk the central directory for the names we want, then
// inflate those members. Data-descriptor entries are handled because sizes
// come from the central directory, not the local header.
function zipFindEOCD(buf) {
  // EOCD signature 0x06054b50, scan backward through the max 64k comment.
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function zipEntries(buf) {
  const eocd = zipFindEOCD(buf);
  if (eocd < 0) throw new Error("Not a ZIP/3MF file (no central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break; // central dir signature
    const method = buf.readUInt16LE(off + 10);
    const csize  = buf.readUInt32LE(off + 20);
    const usize  = buf.readUInt32LE(off + 24);
    const nlen   = buf.readUInt16LE(off + 28);
    const elen   = buf.readUInt16LE(off + 30);
    const clen   = buf.readUInt16LE(off + 32);
    const lho    = buf.readUInt32LE(off + 42);
    const name   = buf.toString("utf8", off + 46, off + 46 + nlen);
    entries[name] = { method, csize, usize, lho };
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

function zipRead(buf, entry) {
  // Local header: skip its own (possibly different) name/extra lengths.
  const lho = entry.lho;
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error("Bad local header");
  const nlen = buf.readUInt16LE(lho + 26);
  const elen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nlen + elen;
  const raw = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error("Unsupported ZIP compression method " + entry.method);
}

// ---- 3MF palette extraction ---------------------------------------------------
function analyze3mf(buf) {
  const entries = zipEntries(buf);
  const psName = Object.keys(entries).find(n => /(^|\/)project_settings\.config$/i.test(n));
  if (!psName) throw new Error("No Metadata/project_settings.config in this 3MF — is it a slicer project file?");
  const ps = JSON.parse(zipRead(buf, entries[psName]).toString("utf8"));

  const palette = (Array.isArray(ps.filament_colour) ? ps.filament_colour : [])
    .map(c => {
      const m = /^#?([0-9a-fA-F]{6})/.exec(String(c || ""));
      return m ? "#" + m[1].toUpperCase() : null;
    });
  if (!palette.length) throw new Error("No filament_colour palette found in project settings");

  // Usage ranking: model_settings.config assigns objects/parts to 1-based
  // extruder indices. Optional — plain (unsliced-plate) files may lack it.
  const usage = {};
  const msName = Object.keys(entries).find(n => /(^|\/)model_settings\.config$/i.test(n));
  if (msName) {
    const xml = zipRead(buf, entries[msName]).toString("utf8");
    const re = /key="extruder"\s+value="(\d+)"/g;
    let m;
    while ((m = re.exec(xml))) {
      const i = parseInt(m[1], 10);
      usage[i] = (usage[i] || 0) + 1;
    }
  }

  const colors = palette
    .map((hex, i) => ({ index: i + 1, hex, parts: usage[i + 1] || 0 }))
    .filter(c => c.hex);
  colors.sort((a, b) => b.parts - a.parts);
  return {
    file: null,
    filamentCount: palette.length,
    colors,
    hasUsage: Object.keys(usage).length > 0
  };
}

// ---- Color math ---------------------------------------------------------------
function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(rgb) {
  return "#" + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

// The blend model. Components: [{rgb:[r,g,b], w: 0..1}]. See header — sRGB-space
// weighted average, fitted to the fork's own preview (exact on the 3-way test).
// This is the single swap point for a future printed-swatch calibration table.
function blendRgb(components) {
  const out = [0, 0, 0];
  for (const c of components) for (let i = 0; i < 3; i++) out[i] += c.w * c.rgb[i];
  return out;
}

// sRGB -> CIELAB (D65) for perceptual distance.
function rgbToLab(rgb) {
  const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const r = lin(rgb[0]), g = lin(rgb[1]), b = lin(rgb[2]);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = (0.2126 * r + 0.7152 * g + 0.0722 * b);
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIEDE2000 — standard perceptual color difference. ~1 = barely perceptible.
function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * deg + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * deg + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += (hbp < 360 ? 360 : -360);
    hbp /= 2;
  } else hbp = h1p + h2p;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
              + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const RC = 2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt(
    Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2)
    + RT * (dCp / SC) * (dHp / SH)
  );
}

function grade(dE) {
  if (dE <= 2)  return { grade: "exact",       gamut: true  };
  if (dE <= 5)  return { grade: "close",       gamut: true  };
  if (dE <= 10) return { grade: "approximate", gamut: true  };
  return          { grade: "out-of-gamut",     gamut: false };
}

// ---- Definition string emitter (verified formats only — see header) ------------
function defString(components, uid) {
  const TAIL = "z0,xa0,xb0,d0,o0,u" + uid + ",cm0";
  if (components.length === 2) {
    // lower index first for consistency; P belongs to the SECOND filament
    // (polarity verified: "2,4,...,40,..m2" -> "F2 60%+F4 40%")
    const [a, b] = [...components].sort((x, y) => x.slot - y.slot);
    return `${a.slot},${b.slot},1,1,${b.pct},0,g,w,m2,${TAIL}`;
  }
  const sorted = [...components].sort((x, y) => x.slot - y.slot);
  const g = sorted.map(c => c.slot).join("");
  const w = sorted.map(c => c.pct).join("/");
  return `1,2,1,1,50,0,g${g},w${w},m0,${TAIL}`;
}

// ---- Solver --------------------------------------------------------------------
// Enumerates every verified-emittable mix over the loaded spools: singles,
// pairs at 5 % steps, triples on a 5 % grid (each component >= 5 %). ~800
// candidates per target — brute force is instant and exact for this space.
// 4-component mixes are deliberately absent: the g/w list format is only
// hardware-verified for 3 components (Rule #1 — don't emit unverified formats).
function solveTarget(targetHex, spools) {
  const target = hexToRgb(targetHex);
  if (!target) return { error: "Bad target color " + targetHex };
  const tLab = rgbToLab(target);
  const loaded = spools.filter(s => s && s.rgb);
  const results = [];

  const consider = (components) => {
    const rgb = blendRgb(components.map(c => ({ rgb: c.rgb, w: c.pct / 100 })));
    const dE = deltaE2000(tLab, rgbToLab(rgb));
    results.push({ components, hex: rgbToHex(rgb), dE });
  };

  for (const s of loaded) consider([{ slot: s.slot, rgb: s.rgb, pct: 100 }]);

  for (let i = 0; i < loaded.length; i++) for (let j = i + 1; j < loaded.length; j++) {
    for (let p = 5; p <= 95; p += 5) {
      consider([
        { slot: loaded[i].slot, rgb: loaded[i].rgb, pct: 100 - p },
        { slot: loaded[j].slot, rgb: loaded[j].rgb, pct: p }
      ]);
    }
  }

  for (let i = 0; i < loaded.length; i++)
    for (let j = i + 1; j < loaded.length; j++)
      for (let k = j + 1; k < loaded.length; k++)
        for (let p1 = 5; p1 <= 90; p1 += 5)
          for (let p2 = 5; p2 <= 95 - p1; p2 += 5) {
            const p3 = 100 - p1 - p2;
            if (p3 < 5) continue;
            consider([
              { slot: loaded[i].slot, rgb: loaded[i].rgb, pct: p1 },
              { slot: loaded[j].slot, rgb: loaded[j].rgb, pct: p2 },
              { slot: loaded[k].slot, rgb: loaded[k].rgb, pct: p3 }
            ]);
          }

  results.sort((a, b) => a.dE - b.dE);
  // Prefer simpler recipes when quality is essentially tied: a single or pair
  // within dE 1.0 of the best triple wins (fewer components = less flushing).
  let best = results[0];
  for (const r of results) {
    if (r.components.length < best.components.length && r.dE <= best.dE + 1.0) best = r;
    if (r.dE > best.dE + 1.0) break;
  }
  const alternates = results.filter(r => r !== best).slice(0, 3);
  const g = grade(best.dE);
  return {
    target: rgbToHex(target),
    best: shapeRecipe(best),
    dE: +best.dE.toFixed(1),
    grade: g.grade,
    inGamut: g.gamut,
    alternates: alternates.map(a => ({ ...shapeRecipe(a), dE: +a.dE.toFixed(1), grade: grade(a.dE).grade }))
  };
}

function shapeRecipe(r) {
  const comps = [...r.components].sort((a, b) => b.pct - a.pct);
  return {
    hex: r.hex,
    components: comps.map(c => ({ slot: c.slot, pct: c.pct })),
    label: comps.map(c => `F${c.slot} ${c.pct}%`).join(" + ")
  };
}

// ---- Routes --------------------------------------------------------------------
module.exports = function mountFsColors(app, express) {
  // Upload a 3MF, get its palette back (colors ranked by part usage).
  app.post("/api/fs-colors/analyze",
    express.raw({ type: () => true, limit: "300mb" }),
    (req, res) => {
      try {
        if (!req.body || !req.body.length) return res.status(400).json({ error: "Empty upload" });
        res.json(analyze3mf(req.body));
      } catch (e) {
        res.status(422).json({ error: e.message });
      }
    });

  // Solve targets against loaded spools.
  // Body: { spools: [hex|null x4 (slot order F1..F4)], targets: [hex, ...] }
  app.post("/api/fs-colors/solve", (req, res) => {
    const { spools, targets } = req.body || {};
    if (!Array.isArray(spools) || !Array.isArray(targets) || !targets.length)
      return res.status(400).json({ error: "Need spools[] and targets[]" });
    const sp = spools.slice(0, 4).map((hex, i) => {
      const rgb = hexToRgb(hex);
      return rgb ? { slot: i + 1, rgb } : null;
    });
    if (sp.filter(Boolean).length < 2)
      return res.status(400).json({ error: "Need at least 2 loaded spool colors" });
    let uid = 0;
    const results = targets.slice(0, 64).map(t => {
      const r = solveTarget(t, sp);
      if (!r.error && r.best.components.length >= 2) r.def = defString(r.best.components, ++uid);
      return r;
    });
    res.json({ results });
  });
};

// Exported for tests / future reuse.
module.exports.analyze3mf = analyze3mf;
module.exports.solveTarget = solveTarget;
module.exports.defString = defString;
