// core/fleet.js — what the farm is doing: head decode, probe, realtime websocket, disk poll, snapshot, SSE
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const http = require("http");

module.exports = function (hub) {
const { app, detectCaps } = hub;


// ---- Fleet: live per-head filament + status across all printers ----
// Colors come from print_task_config (the touchscreen-assigned filament, which
// persists with the physical spools until unloaded). filament_detect was wrong:
// it only reports RFID-tagged official spools, so third-party heads read blank.
function decodeHeads(ptc) {
  const ex   = ptc.filament_exist || [];
  const rgba = ptc.filament_color_rgba || [];
  const typ  = ptc.filament_type || [];
  const sub  = ptc.filament_sub_type || [];
  const off  = ptc.filament_official || [];
  const ven  = ptc.filament_vendor || [];
  const sku  = ptc.filament_sku || [];
  const multi = ptc.filament_color_multi || [];
  return [0, 1, 2, 3].map(i => {
    const loaded = !!ex[i];
    let hex = null;
    if (loaded && rgba[i]) {
      const m = /^#?([0-9a-fA-F]{6})/.exec(rgba[i]);
      if (m) hex = "#" + m[1].toUpperCase();
    }
    // Multi-color spools: filament_color_multi carries {nums, colors[], mode}.
    // Hardware-confirmed as the READ path (single-color spools report nums:1);
    // pass extra colors through so the UI can render gradient swatches. The
    // WRITE path for multi-color is unknown (SET_PRINT_FILAMENT_CONFIG silently
    // ignores unrecognized params, so it can't be probed) — display only.
    let colors = null;
    const mc = multi[i];
    if (loaded && mc && mc.nums > 1 && Array.isArray(mc.colors) && mc.colors.length > 1) {
      colors = mc.colors
        .map(c => /^#?([0-9a-fA-F]{6})/.exec(String(c)))
        .filter(Boolean)
        .map(m2 => "#" + m2[1].toUpperCase());
      if (colors.length < 2) colors = null;
    }
    return {
      loaded,
      hex,
      colors,
      material: loaded ? (typ[i] || null) : null,
      sub: (loaded && sub[i] && sub[i] !== "NONE") ? sub[i] : null,
      official: !!off[i],
      // Identity (tag-verified spool profile). vendor/sku come straight from
      // print_task_config — the same source the color swatch uses, so they never
      // disagree with the displayed color, and (unlike filament_detect) they
      // don't go stale after the load-time RFID scan. Hardware-verified: an
      // official Snapmaker SnapSpeed roll reported vendor "Snapmaker", sku 900002.
      vendor: (loaded && off[i] && ven[i] && ven[i] !== "NONE") ? ven[i] : null,
      sku: (loaded && off[i] && sku[i]) ? sku[i] : null
    };
  });
}


// ---- Per-file metadata cache -------------------------------------------------
// The touchscreen computes progress from header-corrected byte position and its
// countdown from the slicer's estimated_time. Both live in file metadata, which
// only changes when the file changes — so fetch once per (printer, file) and
// re-fetch if the file size stops matching (re-sliced under the same name).
// Verified 2026-07-02: screen showed 1% / 16:03 while display_status said 3%;
// header-corrected bytes × estimated_time reproduced the screen exactly.
const META_CACHE = {};   // key: printer name -> { file, size, start, end, est }

async function fileMeta(base, key, filename, fileSize) {
  const c = META_CACHE[key];
  if (c && c.file === filename && c.size === fileSize) return c;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/server/files/metadata?filename=" + encodeURIComponent(filename), { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const m = ((await r.json()).result) || {};
    let thumb = null;
    if (Array.isArray(m.thumbnails) && m.thumbnails.length) {
      const t = m.thumbnails.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
      if (t && t.relative_path) thumb = String(t.relative_path);
    }
    const rec = {
      file: filename, size: fileSize,
      start: m.gcode_start_byte || 0,
      end: m.gcode_end_byte || 0,
      est: m.estimated_time || 0,
      thumb
    };
    META_CACHE[key] = rec;
    return rec;
  } catch { return null; }
}


// Shape raw Klipper status objects into one fleet-card record. Used by both
// the HTTP probe and the realtime websocket cache — same math either way.
function pauseOrErrorText(ps) {
  if (ps.state !== "error" && ps.state !== "paused") return "";
  const ex = ps.exception;
  if (ex && typeof ex === "object" && ex.message) {
    let t = String(ex.message).trim();
    if (Number.isInteger(ex.index) && ex.index >= 0) t += " (extruder " + ex.index + ")";
    if (Number.isInteger(ex.code)) t += " · code " + ex.code;
    return t.slice(0, 200);
  }
  return (ps.state === "error" && ps.message) ? String(ps.message).slice(0, 200) : "";
}

async function shapeStatus(p, st, base) {
    const ptc = st.print_task_config || {};
    const heads = decodeHeads(ptc);
    const ps = st.print_stats || {};
    const ds = st.display_status || {};
    const vsd = st.virtual_sdcard || {};
    const hb = st.heater_bed || {};
    const eo = st.exclude_object || {};
    const plate = (eo.objects && eo.objects.length)
      ? { total: eo.objects.length, excluded: (eo.excluded_objects || []).length, current: eo.current_object || null }
      : null;
    // logical-filament -> physical-head map (first 4 entries of the table)
    const mapTable = Array.isArray(ptc.extruder_map_table) ? ptc.extruder_map_table.slice(0, 4) : null;
    // Progress: header-corrected byte position through the gcode body — this is
    // what the touchscreen shows. display_status.progress is the slicer's coarse
    // integer M73 P value and runs ahead early in a print.
    let progress = typeof ds.progress === "number" ? ds.progress : 0;
    let etaSec = null;
    if ((ps.state === "printing" || ps.state === "paused") && ps.filename) {
      if (typeof vsd.progress === "number") progress = vsd.progress;
      const meta = await fileMeta(base, p.name, ps.filename, vsd.file_size);
      if (meta && typeof vsd.file_position === "number" && meta.end > meta.start) {
        progress = Math.min(1, Math.max(0,
          (vsd.file_position - meta.start) / (meta.end - meta.start)));
      }
      // Screen-matching countdown: slicer estimate scaled by remaining fraction.
      // Deliberately mirrors the touchscreen (not self-correcting) so the Hub
      // and the screen never disagree.
      if (meta && meta.est > 0) etaSec = Math.max(0, meta.est * (1 - progress));
    }
    // Layer counter — print_stats.info was confirmed live on real hardware
    // (FIFA print reported current_layer 216 / total_layer 302 mid-print).
    const info = ps.info || {};
    const layer = (typeof info.current_layer === "number" && typeof info.total_layer === "number" && info.total_layer > 0)
      ? { cur: info.current_layer, total: info.total_layer } : null;
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      // Firmware error text so failures say WHY on the card. Two sources:
      //   * print_stats.message  - stock Klipper, set on state "error"
      //   * print_stats.exception - Snapmaker's fork; set on the PAUSES its
      //     detectors trigger, while .message stays "". Hardware-verified
      //     2026-09-08 on U2: { id:523, index:0, code:38,
      //     message:"detect filament tangled!", level:2 } with state "paused".
      //     `index` is the extruder the firmware's own log names (extruder[0]).
      message: pauseOrErrorText(ps),
      filename: ps.filename || "",
      progress,
      etaSec,
      layer,
      printDuration: typeof ps.print_duration === "number" ? ps.print_duration : 0,
      bed: (typeof hb.temperature === "number") ? { temp: hb.temperature, target: hb.target || 0 } : null,
      plate,
      heads, mapTable
    };
}


async function probe(p) {
  const base = String(p.url).replace(/\/+$/, "");
  const url = base + "/printer/objects/query?print_task_config&print_stats&display_status&virtual_sdcard&heater_bed&exclude_object";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { name: p.name, online: false, error: "HTTP " + r.status };
    const j = await r.json();
    const st = (j.result && j.result.status) || {};
    return await shapeStatus(p, st, base);
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}


// ---- Realtime farm state: websocket push with HTTP fallback -----------------
// Verified on hardware 2026-07-03: stock Snapmaker firmware accepts websocket
// connections and a printer.objects.subscribe pushes notify_status_update for
// print_stats / display_status / virtual_sdcard etc. (126 events observed in a
// 32 s mid-print capture). print_task_config was NOT observed broadcasting when
// a color changed on the touchscreen, so colors are reconciled by a slow HTTP
// re-query instead of trusting the socket for them.
//
// Uses Node's built-in browser-style WebSocket client (22.4+; pkg targets
// node22, so identical in the packaged exe). Each printer gets one socket with
// exponential-backoff reconnect. If a socket is down, the fleet path falls back
// to the same HTTP probe the Hub has always used — worst case is v2.3.0
// behavior, never worse.
const FARM_SUB = { print_task_config: null, print_stats: null, display_status: null,
                   virtual_sdcard: null, heater_bed: null, exclude_object: null };

const FARMWS = new Map();   // idx -> { ws, status, raw, seenAt, backoff, timer, epoch }

hub.FARM_READY = false;     // var (hoisted): loadConfig runs before this section

let FARM_EPOCH = 0;         // bumped on restart so stale sockets ignore themselves

const WS_FRESH_MS = 10000;  // socket data older than this -> fall back to HTTP


function farmWsConnect(idx) {
  const p = hub.PRINTERS[idx];
  if (!p || typeof WebSocket === "undefined") return;
  const rec = FARMWS.get(idx) || { raw: {}, backoff: 0 };
  rec.epoch = FARM_EPOCH;
  rec.status = "connecting";
  FARMWS.set(idx, rec);
  const wsUrl = String(p.url).replace(/\/+$/, "").replace(/^http/, "ws") + "/websocket";
  let ws;
  try { ws = new WebSocket(wsUrl); } catch { return farmWsScheduleReconnect(idx); }
  rec.ws = ws;
  const myEpoch = rec.epoch;
  ws.onopen = () => {
    if (myEpoch !== FARM_EPOCH) { try { ws.close(); } catch {} return; }
    rec.status = "open"; rec.backoff = 0;
    try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "printer.objects.subscribe", params: { objects: FARM_SUB }, id: 1 })); } catch {}
  };
  ws.onmessage = (ev) => {
    if (myEpoch !== FARM_EPOCH) return;
    let j; try { j = JSON.parse(ev.data); } catch { return; }
    // Subscribe response carries a full snapshot of every requested object.
    if (j.id === 1 && j.result && j.result.status) {
      rec.raw = j.result.status; rec.seenAt = Date.now(); farmMarkDirty(); return;
    }
    // Incremental updates: params[0] holds per-object partial field sets.
    if (j.method === "notify_status_update" && Array.isArray(j.params) && j.params[0]) {
      const part = j.params[0];
      for (const k of Object.keys(part)) {
        if (!(k in FARM_SUB)) continue;
        rec.raw[k] = Object.assign({}, rec.raw[k], part[k]);
      }
      rec.seenAt = Date.now(); farmMarkDirty();
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    if (myEpoch !== FARM_EPOCH) return;
    rec.status = "closed";
    farmWsScheduleReconnect(idx);
  };
}

function farmWsScheduleReconnect(idx) {
  const rec = FARMWS.get(idx);
  if (!rec || rec.epoch !== FARM_EPOCH) return;
  rec.backoff = Math.min(30000, (rec.backoff || 1000) * 2);
  clearTimeout(rec.timer);
  rec.timer = setTimeout(() => farmWsConnect(idx), rec.backoff);
}

function farmWsRestart() {
  FARM_EPOCH++;
  for (const [, rec] of FARMWS) { clearTimeout(rec.timer); try { rec.ws && rec.ws.close(); } catch {} }
  FARMWS.clear();
  (hub.PRINTERS || []).forEach((_, i) => farmWsConnect(i));
}

hub.FARM_READY = true;

farmWsRestart();


// Colors don't broadcast (hardware-observed), so re-query print_task_config
// over HTTP every 20 s per connected printer and splice it into the socket
// cache. Touchscreen color changes therefore appear within one reconcile tick.
setInterval(() => {
  for (const [idx, rec] of FARMWS) {
    if (rec.status !== "open" || !rec.seenAt) continue;
    const p = hub.PRINTERS[idx]; if (!p) continue;
    const base = String(p.url).replace(/\/+$/, "");
    fetch(base + "/printer/objects/query?print_task_config")
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        const ptc = j && j.result && j.result.status && j.result.status.print_task_config;
        if (ptc) {
          const before = JSON.stringify(rec.raw.print_task_config || {});
          rec.raw.print_task_config = ptc;
          if (JSON.stringify(ptc) !== before) farmMarkDirty();
        }
      }).catch(() => {});
  }
}, 20000);


// Disk usage per printer — /server/files/directory?extended=true returned 200
// with disk totals on live hardware (probe session). Slow-moving: 60 s cadence.
const DISK_CACHE = new Map(); // idx -> { free, total, at }

async function diskPoll() {
  for (let i = 0; i < (hub.PRINTERS || []).length; i++) {
    const p = hub.PRINTERS[i];
    const base = String(p.url).replace(/\/+$/, "");
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(base + "/server/files/directory?extended=true", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const du = (((await r.json()).result) || {}).disk_usage || {};
      const free = (typeof du.free === "number") ? du.free : (typeof du.available === "number" ? du.available : null);
      const total = (typeof du.total === "number") ? du.total : null;
      if (free !== null) DISK_CACHE.set(i, { free, total, at: Date.now() });
    } catch {}
  }
}

setInterval(diskPoll, 60000);

setTimeout(diskPoll, 3000);


// ---- Chamber camera: extracted to modules/camera.js (v2.11) ----------------

// One fleet-card record per printer: fresh socket data shapes instantly with
// zero HTTP; otherwise fall back to the classic HTTP probe with a short cache
// so SSE broadcasts can't hammer offline printers with timeout storms.
const PROBE_CACHE = new Map(); // idx -> { data, at }

async function probeCached(p, idx) {
  const rec = FARMWS.get(idx);
  const base = String(p.url).replace(/\/+$/, "");
  let data;
  if (rec && rec.status === "open" && rec.seenAt && (Date.now() - rec.seenAt) < WS_FRESH_MS) {
    data = await shapeStatus(p, rec.raw, base);
  } else {
    const c = PROBE_CACHE.get(idx);
    if (c && (Date.now() - c.at) < 4000) { data = c.data; }
    else { data = await probe(p); PROBE_CACHE.set(idx, { data, at: Date.now() }); }
  }
  const disk = DISK_CACHE.get(idx);
  if (disk && data && data.online) { data.diskFree = disk.free; data.diskTotal = disk.total; }
  // Capability layer: attach detected caps so the UI gates features on what the
  // machine actually reports, never on the type label. A generic Klipper box
  // (no print_task_config) gets its Snapmaker-specific heads array blanked —
  // decodeHeads on an absent object would fabricate 4 empty U1 heads.
  if (data && data.online) {
    const caps = await detectCaps(idx);
    data.caps = caps;
    if (caps && !caps.multiColor) { data.heads = []; data.mapTable = null; }
  }
  return data;
}

async function fleetSnapshot() {
  // `plug` is attached centrally (not threaded through every probe/offline
  // return) so a plugged-but-offline printer still shows its power tile — that's
  // exactly when you'd want to switch it on. Only the type is exposed; the plug
  // IP stays server-side (the browser drives it through /api/power?id=N).
  // v2.16: `url` is exposed so the card's name can link straight to the
  // printer's own Klipper/Fluidd UI (community request). This is NOT the same
  // call as the plug IP above: the plug is a third-party device the browser has
  // no business addressing, so the Hub proxies it. The printer's URL is already
  // served in full by /api/config behind the same auth, and the browser has to
  // know it to navigate there at all — withholding it here would buy nothing.
  // LAN-only by nature: over the Cloudflare tunnel a 192.168.x link won't
  // resolve, which the UI says on the link itself rather than hiding it.
  // v2.20: `maintenance` — a machine the user deliberately took out of service.
  // Owned by the dispatch module, but every surface that draws a printer needs
  // it: it shipped visible only on the Dispatch guide, and the Dash card for a
  // machine that was down still read "IDLE". Resolved through the capability
  // map at CALL time, so it is simply absent when dispatch is switched off.
  let maint = {};
  try {
    const f = hub.CAPS_PROVIDED.get("dispatch.maintenance");
    if (f) maint = f() || {};
  } catch {}
  return Promise.all((hub.PRINTERS || []).map((p, i) =>
    probeCached(p, i).then(r => ({ id: i, ptype: p.type || "u1", url: p.url || null, plug: (hub.FEATURES.power && p.plug) ? { type: p.plug.type } : null,
      maintenance: maint[String(i)] ? { since: maint[String(i)].since, note: maint[String(i)].note || "" } : null, ...r }))));
}


app.get("/api/fleet", async (req, res) => {
  res.json(await fleetSnapshot());
});


// ---- Server-sent events: push fleet state to browsers the moment it changes.
// The page falls back to its 5 s poll automatically if this stream drops.
const SSE_CLIENTS = new Set();

app.get("/api/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 4000\n\n");
  SSE_CLIENTS.add(res);
  req.on("close", () => SSE_CLIENTS.delete(res));
});

let SSE_LAST = "", SSE_TIMER = null, SSE_BUSY = false;

function farmMarkDirty() {
  if (SSE_TIMER) return;                    // debounce: batch bursts into one push
  SSE_TIMER = setTimeout(sseBroadcast, 1000);   // v2.11: was 300 — client renders 1/s anyway
}

async function sseBroadcast() {
  SSE_TIMER = null;
  if (SSE_BUSY || SSE_CLIENTS.size === 0) return;
  SSE_BUSY = true;
  try {
    const snap = JSON.stringify(await fleetSnapshot());
    if (snap !== SSE_LAST) {
      SSE_LAST = snap;
      for (const c of SSE_CLIENTS) { try { c.write("data: " + snap + "\n\n"); } catch {} }
    }
  } catch {} finally { SSE_BUSY = false; }
}

// Slow safety tick: catches drift the sockets don't broadcast (bed temp on
// HTTP-only printers, disk, reconciled colors) and keeps streams warm.
setInterval(() => { farmMarkDirty(); }, 5000);

setInterval(() => { for (const c of SSE_CLIENTS) { try { c.write(": hb\n\n"); } catch {} } }, 20000);

Object.assign(hub, { decodeHeads, farmWsRestart, fileMeta, fleetSnapshot });
};
