// modules/mesh3mf.js — what a 3MF's meshes say about how it will print (v2.28).
//
// The AI settings suggester (modules/advisor.js, /api/advisor/model) cannot
// hand Claude a mesh, and a model cannot look at one anyway. What it CAN use
// is a handful of numbers that decide slicer settings, measured here from the
// triangles themselves: how big the plate is, how tall the tallest part is
// against its narrowest base (does it want a brim), what share of the surface
// faces down steeply (does it want supports, and how much), whether anything
// is flat and floating (bridges, or a part that needs a raft of support),
// how much of the footprint actually touches the bed, whether faces are
// painted with several colors (multi-color by painting, not by parts), and
// the solid volume (a ceiling on the grams). Pure: no fs, no config. The
// caller hands over a zip index with entries and a content(e) reader (the
// range reader in modules/models.js), and gets facts back.
//
// 3MF shapes handled: the core spec (meshes inline in 3D/3dmodel.model) and
// the production extension Bambu/Orca projects use (3dmodel.model holds
// components that point at 3D/Objects/*.model by p:path; each of those holds
// one mesh). Build items and components carry a 3x4 row-major transform,
// applied as p' = p * M + t; components compose. Multi-plate projects: the
// caller can restrict the build items to one plate's object ids (from
// Metadata/model_settings.config), which platesFromModelSettings reads.
//
// Cost: a painted mini is 200,000 triangles and 16 MB of XML; a big plate can
// be 1,000,000. Parsing is a hand-rolled scan (indexOf + parseFloat), not a
// regex over the whole document, and it yields to the event loop every
// 20,000 tags so nine printers keep polling while a 40 MB mesh is measured.
// A total budget (MAX_BYTES) stops a pathological file from eating memory:
// past it, the facts come back with truncated:true and what was measured.

"use strict";

const MAX_BYTES = 160 * 1024 * 1024;   // uncompressed XML across all mesh files
const YIELD_EVERY = 20000;
const STEEP_DEG = 60;       // face-normal angle from straight down; < 60 means the wall leans more than 30 deg past vertical (Orca's default support threshold)
const FLAT_DEG = 10;        // faces this close to horizontal, pointing down, are undersides
const BED_EPS = 0.3;        // mm above the lowest point still counts as touching the bed

const yieldLoop = () => new Promise(r => setImmediate(r));

// ---- XML scan --------------------------------------------------------------
// Attribute reader for one tag's text: attr(tag, "x") -> "2.89" | null.
function attr(tag, name) {
  const i = tag.indexOf(" " + name + "=");
  if (i < 0) return null;
  const q = tag.charCodeAt(i + name.length + 2);
  const start = i + name.length + 3;
  const end = tag.indexOf(q === 39 ? "'" : '"', start);
  return end < 0 ? null : tag.slice(start, end);
}
function parseTransform(s) {
  if (!s) return null;
  const n = String(s).trim().split(/\s+/).map(Number);
  return n.length === 12 && n.every(Number.isFinite) ? n : null;
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
// child then parent: p'' = (p*C + tc)*P + tp
function compose(P, C) {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22, ax, ay, az] = C;
  const [b00, b01, b02, b10, b11, b12, b20, b21, b22, bx, by, bz] = P;
  return [
    a00 * b00 + a01 * b10 + a02 * b20, a00 * b01 + a01 * b11 + a02 * b21, a00 * b02 + a01 * b12 + a02 * b22,
    a10 * b00 + a11 * b10 + a12 * b20, a10 * b01 + a11 * b11 + a12 * b21, a10 * b02 + a11 * b12 + a12 * b22,
    a20 * b00 + a21 * b10 + a22 * b20, a20 * b01 + a21 * b11 + a22 * b21, a20 * b02 + a21 * b12 + a22 * b22,
    ax * b00 + ay * b10 + az * b20 + bx, ax * b01 + ay * b11 + az * b21 + by, ax * b02 + ay * b12 + az * b22 + bz
  ];
}

// One .model document -> { metadata, objects: Map(id -> { mesh, components }), build: [{ objectid, path, transform }] }
// mesh = { verts: Float64Array (x,y,z,...), tris: Uint32Array (v1,v2,v3,...), paint: Map(color -> count), painted: n }
async function parseModel(text) {
  const out = { metadata: {}, objects: new Map(), build: [] };
  // Root metadata (Title, Designer, ProfileTitle …) lives before <resources>.
  const head = text.slice(0, text.indexOf("<resources") > 0 ? text.indexOf("<resources") : 4000);
  for (const m of head.matchAll(/<metadata name="([^"]+)">([^<]*)<\/metadata>/g)) out.metadata[m[1]] = m[2];
  let pos = 0, n = 0;
  const len = text.length;
  let cur = null;   // the <object> being filled
  while (pos < len) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) break;
    const gt = text.indexOf(">", lt);
    if (gt < 0) break;
    const tag = text.slice(lt, gt + 1);
    pos = gt + 1;
    if (++n % YIELD_EVERY === 0) await yieldLoop();
    const c1 = tag.charCodeAt(1);
    if (c1 === 118 /* v */) {
      if (cur && tag.startsWith("<vertex ")) {
        cur.vx.push(+attr(tag, "x"), +attr(tag, "y"), +attr(tag, "z"));
      }
      continue;
    }
    if (c1 === 116 /* t */) {
      if (cur && tag.startsWith("<triangle ")) {
        cur.ti.push(+attr(tag, "v1"), +attr(tag, "v2"), +attr(tag, "v3"));
        // Bambu paints faces with paint_color="…" (an mmu segmentation
        // string); Prusa/Orca use slic3rpe:mmu_segmentation. Either way a
        // painted face carries an attribute an unpainted one does not.
        const pc = attr(tag, "paint_color") || attr(tag, "slic3rpe:mmu_segmentation");
        if (pc) { cur.painted++; cur.paint.set(pc, (cur.paint.get(pc) || 0) + 1); }
      }
      continue;
    }
    if (c1 === 111 /* o */ && tag.startsWith("<object ")) {
      cur = { id: attr(tag, "id"), vx: [], ti: [], paint: new Map(), painted: 0, components: [] };
      out.objects.set(cur.id, cur);
      continue;
    }
    if (c1 === 47 /* / */ && tag === "</object>") { cur = null; continue; }
    if (c1 === 99 /* c */ && cur && tag.startsWith("<component ")) {
      cur.components.push({ objectid: attr(tag, "objectid"), path: attr(tag, "p:path"), transform: parseTransform(attr(tag, "transform")) || IDENTITY });
      continue;
    }
    if (c1 === 105 /* i */ && tag.startsWith("<item ")) {
      out.build.push({ objectid: attr(tag, "objectid"), path: attr(tag, "p:path"), transform: parseTransform(attr(tag, "transform")) || IDENTITY, printable: attr(tag, "printable") });
      continue;
    }
  }
  for (const o of out.objects.values()) {
    o.mesh = o.ti.length ? { verts: Float64Array.from(o.vx), tris: Uint32Array.from(o.ti), paint: o.paint, painted: o.painted } : null;
    delete o.vx; delete o.ti;
  }
  return out;
}

// Measure one mesh under a transform. Returns per-instance stats.
async function measure(mesh, M) {
  const { verts, tris } = mesh;
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22, tx, ty, tz] = M;
  const nv = verts.length / 3;
  const X = new Float64Array(nv), Y = new Float64Array(nv), Z = new Float64Array(nv);
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    const px = x * m00 + y * m10 + z * m20 + tx, py = x * m01 + y * m11 + z * m21 + ty, pz = x * m02 + y * m12 + z * m22 + tz;
    X[i] = px; Y[i] = py; Z[i] = pz;
    if (px < minx) minx = px; if (px > maxx) maxx = px;
    if (py < miny) miny = py; if (py > maxy) maxy = py;
    if (pz < minz) minz = pz; if (pz > maxz) maxz = pz;
    if (i % (YIELD_EVERY * 4) === 0 && i) await yieldLoop();
  }
  const cosSteep = Math.cos(STEEP_DEG * Math.PI / 180), cosFlat = Math.cos(FLAT_DEG * Math.PI / 180);
  let area = 0, vol = 0, steep = 0, flat = 0, flatBed = 0, mild = 0, upFlat = 0;
  const nt = tris.length / 3;
  const bedZ = minz + BED_EPS;
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    if (a >= nv || b >= nv || c >= nv) continue;
    const e1x = X[b] - X[a], e1y = Y[b] - Y[a], e1z = Z[b] - Z[a];
    const e2x = X[c] - X[a], e2y = Y[c] - Y[a], e2z = Z[c] - Z[a];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(l > 1e-9)) continue;
    const ar = l / 2;
    area += ar;
    vol += (X[a] * nx + Y[a] * ny + Z[a] * nz) / 6;
    const dz = nz / l;   // +1 straight up, -1 straight down
    if (dz < 0) {
      const down = -dz;   // cos of the angle from straight down
      if (down >= cosFlat) { if (Z[a] <= bedZ && Z[b] <= bedZ && Z[c] <= bedZ) flatBed += ar; else flat += ar; }
      else if (down > cosSteep) steep += ar;
      else mild += ar;
    } else if (dz >= cosFlat) upFlat += ar;
    if (t % YIELD_EVERY === 0 && t) await yieldLoop();
  }
  // A mesh with inward-facing normals reports a negative volume; the size is
  // what matters, the sign is a modeling accident.
  return { minx, miny, minz, maxx, maxy, maxz, area, volume: Math.abs(vol), steep, flat, flatBed, mild, upFlat, tris: nt };
}

// Metadata/model_settings.config: which root object ids sit on which plate,
// and each object's name. { plates: [{ id, objects: [ids] }], names: Map(id -> name) }
function platesFromModelSettings(xml) {
  const t = String(xml || "");
  const names = new Map();
  for (const m of t.matchAll(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    const nm = /<metadata key="name" value="([^"]*)"/.exec(m[2]);
    if (nm) names.set(m[1], nm[1]);
  }
  const plates = [];
  for (const m of t.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const pid = /<metadata key="plater_id" value="(\d+)"/.exec(m[1]);
    const objs = [...m[1].matchAll(/<metadata key="object_id" value="(\d+)"/g)].map(x => x[1]);
    plates.push({ id: pid ? Number(pid[1]) : plates.length + 1, objects: objs });
  }
  return { plates, names };
}

// z: { entries: [{ name, usize }], content(e) -> Buffer }. opts: { only: Set of
// root object ids (one plate), names: Map(id -> name), maxBytes }.
async function facts3mf(z, opts) {
  const o = opts || {};
  const maxBytes = o.maxBytes || MAX_BYTES;
  const t0 = Date.now();
  const byName = new Map(z.entries.map(e => [e.name.replace(/^\//, ""), e]));
  const rootE = z.entries.find(e => /^\/?3D\/3dmodel\.model$/i.test(e.name));
  if (!rootE) return { ok: false, reason: "no 3D/3dmodel.model in the file" };
  let bytes = 0, truncated = false;
  const docs = new Map();   // path -> parsed model
  async function load(pathKey) {
    const key = String(pathKey || "3D/3dmodel.model").replace(/^\//, "");
    if (docs.has(key)) return docs.get(key);
    const e = byName.get(key) || byName.get(decodeURIComponent(key));
    if (!e) { docs.set(key, null); return null; }
    if (bytes + (e.usize || 0) > maxBytes) { truncated = true; docs.set(key, null); return null; }
    bytes += e.usize || 0;
    const buf = await z.content(e);
    const doc = await parseModel(buf.toString("utf8"));
    docs.set(key, doc);
    return doc;
  }
  const root = await load("3D/3dmodel.model");
  if (!root) return { ok: false, reason: "could not read 3D/3dmodel.model" };

  // Resolve build items to mesh instances.
  const leaves = [];
  async function walk(pathKey, objectid, M, depth, rootId) {
    if (depth > 8) return;
    const doc = await load(pathKey);
    const obj = doc && doc.objects.get(String(objectid));
    if (!obj) return;
    if (obj.mesh) { leaves.push({ key: (pathKey || "root") + "#" + objectid, mesh: obj.mesh, M, rootId }); return; }
    for (const c of obj.components) await walk(c.path || pathKey, c.objectid, compose(M, c.transform), depth + 1, rootId);
  }
  const items = root.build.filter(it => it.printable !== "0" && (!o.only || o.only.has(String(it.objectid))));
  for (const it of items) await walk(it.path || null, it.objectid, it.transform, 0, String(it.objectid));

  // Measure. The same mesh placed 24 times is measured 24 times (transforms
  // differ) but parsed once - parse is the expensive half.
  const inst = [];
  for (const lf of leaves) {
    const s = await measure(lf.mesh, lf.M);
    inst.push({ ...s, key: lf.key, rootId: lf.rootId, painted: lf.mesh.painted, paint: lf.mesh.paint });
  }
  if (!inst.length) return { ok: false, reason: truncated ? "mesh data past the size budget" : "no printable mesh found", truncated, bytes };

  const g = { minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity, area: 0, volume: 0, steep: 0, flat: 0, bed: 0, mild: 0, upFlat: 0, tris: 0 };
  for (const s of inst) {
    g.minx = Math.min(g.minx, s.minx); g.miny = Math.min(g.miny, s.miny); g.minz = Math.min(g.minz, s.minz);
    g.maxx = Math.max(g.maxx, s.maxx); g.maxy = Math.max(g.maxy, s.maxy); g.maxz = Math.max(g.maxz, s.maxz);
    g.area += s.area; g.volume += s.volume; g.steep += s.steep; g.mild += s.mild; g.upFlat += s.upFlat; g.tris += s.tris;
  }
  // Undersides: flat faces at an instance's own lowest point are bed contact
  // only if that instance sits on the plate; an instance floating above the
  // lowest point of the build is unsupported all the way down.
  const floating = [];
  for (const s of inst) {
    if (s.minz > g.minz + 0.5) { g.flat += s.flat + s.flatBed; floating.push(s); }
    else { g.flat += s.flat; g.bed += s.flatBed; }
  }
  const w = g.maxx - g.minx, d = g.maxy - g.miny, h = g.maxz - g.minz;
  const footprint = Math.max(w * d, 1e-9);
  // Tallest instance and its aspect against its narrowest base dimension.
  let tallest = null;
  for (const s of inst) {
    const ih = s.maxz - s.minz, iw = s.maxx - s.minx, id = s.maxy - s.miny;
    const aspect = ih / Math.max(Math.min(iw, id), 0.01);
    if (!tallest || ih > tallest.height_mm) tallest = { height_mm: r1(ih), base_mm: [r1(iw), r1(id)], aspect: r1(aspect), rootId: s.rootId };
  }
  // Paint: distinct colors across every instance (a color id is per project).
  const paint = new Map(); let paintedArea = 0, paintedTris = 0;
  for (const s of inst) { if (s.painted) { paintedTris += s.painted; for (const [k, v] of s.paint) paint.set(k, (paint.get(k) || 0) + v); } }
  // Distinct parts: group instances by mesh key.
  const groups = new Map();
  for (const s of inst) { const gg = groups.get(s.key) || { key: s.key, copies: 0, volume: 0, rootIds: new Set(), size: [0, 0, 0] }; gg.copies++; gg.volume += s.volume; gg.rootIds.add(s.rootId); gg.size = [r1(s.maxx - s.minx), r1(s.maxy - s.miny), r1(s.maxz - s.minz)]; groups.set(s.key, gg); }
  const names = o.names || new Map();
  const parts = [...groups.values()].sort((a, b) => b.volume - a.volume).slice(0, 12).map(gg => ({
    name: [...gg.rootIds].map(id => names.get(id)).find(Boolean) || null, copies: gg.copies, size_mm: gg.size, volume_cm3: r2(gg.volume / 1000)
  }));
  return {
    ok: true, truncated, bytes, ms: Date.now() - t0,
    instances: inst.length, meshes: groups.size, triangles: g.tris,
    size_mm: [r1(w), r1(d), r1(h)], height_mm: r1(h), footprint_cm2: r1(footprint / 100),
    volume_cm3: r2(g.volume / 1000), area_cm2: r1(g.area / 100),
    solid_g_pla: r1(g.volume / 1000 * 1.24),
    overhang: {
      steep_pct: pct(g.steep, g.area),            // walls leaning > 30 deg from vertical, facing down
      flat_unsupported_pct: pct(g.flat, g.area),  // undersides not on the bed: bridges, or floating parts
      mild_pct: pct(g.mild, g.area),
      bed_contact_cm2: r1(g.bed / 100),
      bed_contact_pct_of_footprint: pct(g.bed, footprint),
      floating_instances: floating.length
    },
    tallest,
    paint: { colors: paint.size, painted_tris: paintedTris, painted_pct: pct(paintedTris, g.tris) },
    parts,
    // The few root metadata fields worth carrying (Description is the
    // designer's whole HTML listing; it stays out).
    metadata: Object.fromEntries(["Title", "Designer", "ProfileTitle", "Application", "License"].filter(k => root.metadata[k]).map(k => [k, root.metadata[k]]))
  };
  function pct(a, b) { return b > 0 ? Math.round(a / b * 1000) / 10 : 0; }
}
function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }

module.exports = { facts3mf, parseModel, measure, platesFromModelSettings, compose, parseTransform, MAX_BYTES };
