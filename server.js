// server.js — U1 Print Hub  ·  v1.4
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "1.4";

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseGcodeMap } = require("./parser");

// When packaged as a single executable (pkg), __dirname points inside the
// read-only bundle. User-editable files (config.json, the gcode folder) must
// live NEXT TO THE EXE instead. Bundled assets (public/, parser.js) stay on
// __dirname, which pkg maps into the snapshot.
const IS_PKG = typeof process.pkg !== "undefined";
const BASE_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;
const ASSET_DIR = __dirname;

const CONFIG_PATH = path.join(BASE_DIR, "config.json");
const DEFAULT_CFG = { gcodeFolder: "./gcode", port: 4545, printers: [], tip: { label: "Buy me a beer 🍺", url: "https://venmo.com/u/dgambill" } };

// Live config — editable from the Settings page, no restart needed.
let CFG, FOLDER, PRINTERS;
function loadConfig() {
  try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { CFG = { ...DEFAULT_CFG }; }
  FOLDER = path.resolve(BASE_DIR, CFG.gcodeFolder || "./gcode");
  PRINTERS = Array.isArray(CFG.printers) ? CFG.printers : [];
  try { fs.mkdirSync(FOLDER, { recursive: true }); } catch {}
}
loadConfig();
const PORT = CFG.port || 4545;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ASSET_DIR, "public")));
// Explicit index route so the UI is served even when running from a packaged
// binary (where express.static from the snapshot can be unreliable).
app.get("/", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8")); }
  catch (e) { res.status(500).send("index.html not found"); }
});

// Resolve a requested filename safely INSIDE the watched folder (no traversal).
function safeFile(name) {
  if (!name) return null;
  const p = path.resolve(FOLDER, path.basename(name));
  return p.startsWith(FOLDER) ? p : null;
}

app.get("/api/printers", (req, res) => {
  res.json(PRINTERS.map((p, i) => ({ id: i, name: p.name })));
});

app.get("/api/files", (req, res) => {
  try {
    const files = fs.readdirSync(FOLDER)
      .filter(f => /\.(gcode|gco|g)$/i.test(f))
      .map(f => {
        const st = fs.statSync(path.join(FOLDER, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ folder: FOLDER, files });
  } catch (e) {
    res.status(500).json({ error: "Cannot read folder " + FOLDER + " — " + e.message });
  }
});

app.get("/api/map", (req, res) => {
  const fp = safeFile(req.query.file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  try {
    // The Orca config block (colours + "filament used [g]") lives at the END of
    // the file, so read just the tail — turns a 200MB read into ~2MB and skips
    // the body scan entirely. Fall back to the whole file only if the colour
    // config isn't found in the tail.
    const TAIL = 3 * 1024 * 1024;
    const size = fs.statSync(fp).size;
    let text;
    if (size > TAIL) {
      const fd = fs.openSync(fp, "r");
      try {
        const buf = Buffer.alloc(TAIL);
        fs.readSync(fd, buf, 0, TAIL, size - TAIL);
        text = buf.toString("utf8");
      } finally { fs.closeSync(fd); }
    } else {
      text = fs.readFileSync(fp, "utf8");
    }
    let result = parseGcodeMap(text, { scanBody: false });
    if (result.noColors && size > TAIL) {
      // Colours weren't in the tail — fall back to a full parse (rare).
      result = parseGcodeMap(fs.readFileSync(fp, "utf8"), { scanBody: true });
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Rewrite the file's palette colors so each chosen color exactly equals the
// target head's loaded color. The U1 matches file-colors to loaded heads, so an
// exact match forces deterministic routing. colorMap = { paletteIndex: "#RRGGBB" }.
function rewriteColors(text, colorMap) {
  const rebuild = v => {
    const parts = v.split(";");
    for (const k in colorMap) { const i = +k; if (i >= 0 && i < parts.length) parts[i] = colorMap[k]; }
    return parts.join(";");
  };
  text = text.replace(/^(; filament_colour = )([^\r\n]*)/m, (m, p, v) => p + rebuild(v));
  text = text.replace(/^(; extruder_colour = )([^\r\n]*)/m, (m, p, v) => p + rebuild(v));
  return text;
}

app.post("/api/print", async (req, res) => {
  const { file, printer, start, map } = req.body || {};
  const fp = safeFile(file);
  if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: "File not found" });
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });

  // map is { logicalToolIndex: physicalHeadIndex }. Reject two tools → same head.
  let tools = [];
  if (map && Object.keys(map).length) {
    tools = Object.keys(map).map(Number).sort((a, b) => a - b);
    const heads = tools.map(t => map[t]);
    if (new Set(heads).size !== heads.length) {
      return res.status(400).json({ error: "Two colors are mapped to the same head — give each its own head." });
    }
  }

  const base = String(p.url).replace(/\/+$/, "");
  const name = path.basename(fp);
  const gcode = async script => {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent(script), { method: "POST" });
    const body = await r.text();
    if (!r.ok) throw new Error("gcode (" + r.status + "): " + body.slice(0, 200));
  };

  try {
    // 1) Upload the file WITHOUT auto-printing (so we can set the map first).
    const form = new FormData();                        // Node 18+ global
    form.append("file", new Blob([fs.readFileSync(fp)]), name);
    const up = await fetch(base + "/server/files/upload", { method: "POST", body: form });
    if (!up.ok) return res.status(502).json({ error: "Upload " + up.status + ": " + (await up.text()).slice(0, 200) });

    // 2) Send the toolhead mapping exactly the way Orca does — Klipper macros.
    if (tools.length) {
      const lines = tools.map(t => `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${t} MAP_EXTRUDER=${map[t]}`);
      lines.push("SET_PRINT_USED_EXTRUDERS EXTRUDERS=" + tools.map(t => map[t]).join(","));
      lines.push("SET_PRINT_PREFERENCES BED_LEVEL=0 FLOW_CALIBRATE=0 TIME_LAPSE_CAMERA=0");
      await gcode(lines.join("\n"));
    }

    // 3) Start the print (after the map is set).
    if (start) await gcode(`SDCARD_PRINT_FILE FILENAME="${name}"`);

    res.json({ ok: true, printer: p.name, started: !!start, mapped: tools.length });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + " (" + base + "): " + e.message });
  }
});

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
  return [0, 1, 2, 3].map(i => {
    const loaded = !!ex[i];
    let hex = null;
    if (loaded && rgba[i]) {
      const m = /^#?([0-9a-fA-F]{6})/.exec(rgba[i]);
      if (m) hex = "#" + m[1].toUpperCase();
    }
    return {
      loaded,
      hex,
      material: loaded ? (typ[i] || null) : null,
      sub: (loaded && sub[i] && sub[i] !== "NONE") ? sub[i] : null,
      official: !!off[i]
    };
  });
}

async function probe(p) {
  const base = String(p.url).replace(/\/+$/, "");
  const url = base + "/printer/objects/query?print_task_config&print_stats&display_status&heater_bed";
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { name: p.name, online: false, error: "HTTP " + r.status };
    const j = await r.json();
    const st = (j.result && j.result.status) || {};
    const ptc = st.print_task_config || {};
    const heads = decodeHeads(ptc);
    const ps = st.print_stats || {};
    const ds = st.display_status || {};
    const hb = st.heater_bed || {};
    // logical-filament -> physical-head map (first 4 entries of the table)
    const mapTable = Array.isArray(ptc.extruder_map_table) ? ptc.extruder_map_table.slice(0, 4) : null;
    return {
      name: p.name, online: true,
      state: ps.state || "unknown",
      filename: ps.filename || "",
      progress: typeof ds.progress === "number" ? ds.progress : 0,
      bed: (typeof hb.temperature === "number") ? { temp: hb.temperature, target: hb.target || 0 } : null,
      heads, mapTable
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

app.get("/api/fleet", async (req, res) => {
  const out = await Promise.all(PRINTERS.map((p, i) => probe(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});

// ---- Set bed temperature on a printer (M140 — standard, no wait) ----
app.post("/api/bedtemp", async (req, res) => {
  const { printer, temp } = req.body || {};
  const p = PRINTERS[printer];
  if (!p) return res.status(400).json({ error: "Unknown printer" });
  const t = Number(temp);
  if (!Number.isFinite(t) || t < 0 || t > 120) return res.status(400).json({ error: "Temp must be 0–120 °C" });
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const r = await fetch(base + "/printer/gcode/script?script=" + encodeURIComponent("M140 S" + Math.round(t)), { method: "POST" });
    if (!r.ok) return res.status(502).json({ error: "Moonraker " + r.status + ": " + (await r.text()).slice(0, 160) });
    res.json({ ok: true, printer: p.name, target: Math.round(t) });
  } catch (e) {
    res.status(502).json({ error: "Could not reach " + p.name + ": " + e.message });
  }
});

// ---- Network inventory: name / IP / MAC / serial, for DHCP reservations ----
function pickIface(net) {
  let fallback = null;
  for (const name in net) {
    const ifc = net[name] || {};
    const v4 = (ifc.ip_addresses || []).find(a => a.family === "ipv4" && !a.is_link_local);
    if (v4) return { iface: name, mac: ifc.mac_address || null, ip: v4.address };
    if (!fallback && ifc.mac_address) fallback = { iface: name, mac: ifc.mac_address, ip: null };
  }
  return fallback || { iface: null, mac: null, ip: null };
}

async function probeInfo(p) {
  const base = String(p.url).replace(/\/+$/, "");
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base + "/machine/system_info", { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { name: p.name, online: false, error: "HTTP " + r.status };
    const si = (await r.json()).result.system_info || {};
    const pi = si.product_info || {};
    const { iface, mac, ip } = pickIface(si.network || {});
    return {
      name: p.name, online: true,
      device_name: pi.device_name || null,
      machine_type: pi.machine_type || null,
      serial: pi.serial_number || null,
      iface, mac, ip
    };
  } catch (e) {
    return { name: p.name, online: false, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

app.get("/api/inventory", async (req, res) => {
  const out = await Promise.all(PRINTERS.map((p, i) => probeInfo(p).then(r => ({ id: i, ...r }))));
  res.json(out);
});

// ---- Settings: read/write config from the UI (no file editing) ----
function publicCfg() {
  return { gcodeFolder: CFG.gcodeFolder || "./gcode", folderResolved: FOLDER, printers: PRINTERS, tip: CFG.tip || null, configured: PRINTERS.length > 0 };
}
app.get("/api/config", (req, res) => res.json(publicCfg()));
app.get("/api/version", (req, res) => res.json({ version: VERSION }));

app.post("/api/config", (req, res) => {
  const b = req.body || {};
  const next = {
    gcodeFolder: (typeof b.gcodeFolder === "string" && b.gcodeFolder.trim()) ? b.gcodeFolder.trim() : (CFG.gcodeFolder || "./gcode"),
    port: PORT,
    printers: Array.isArray(b.printers)
      ? b.printers.filter(p => p && p.url).map(p => ({ name: String(p.name || p.url), url: String(p.url) }))
      : (CFG.printers || []),
    tip: (b.tip && (b.tip.url || b.tip.label)) ? { label: String(b.tip.label || "Buy me a beer"), url: String(b.tip.url || "") } : (b.tip === null ? null : (CFG.tip || null))
  };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
    loadConfig();
    res.json({ ok: true, ...publicCfg() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Auto-discovery: scan the local subnet(s) for Moonraker printers ----
function localSubnets() {
  const out = new Set();
  const ifs = os.networkInterfaces();
  for (const name in ifs) for (const a of ifs[name] || []) {
    if (a.family === "IPv4" && !a.internal) out.add(a.address.split(".").slice(0, 3).join("."));
  }
  return [...out];
}
async function probeMoonraker(ip) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 900);
    const r = await fetch(`http://${ip}/machine/system_info`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const si = ((await r.json()).result || {}).system_info;
    if (!si) return null;
    const pi = si.product_info || {};
    const { mac } = pickIface(si.network || {});
    return { ip, url: `http://${ip}`, device_name: pi.device_name || null, machine_type: pi.machine_type || null, serial: pi.serial_number || null, mac };
  } catch { return null; }
}
app.get("/api/discover", async (req, res) => {
  const found = [];
  for (const base of localSubnets()) {
    const ips = [];
    for (let i = 1; i <= 254; i++) ips.push(base + "." + i);
    const B = 40;
    for (let i = 0; i < ips.length; i += B) {
      const results = await Promise.all(ips.slice(i, i + B).map(probeMoonraker));
      results.forEach(r => { if (r) found.push(r); });
    }
  }
  res.json({ subnets: localSubnets(), found });
});

app.listen(PORT, () => {
  const url = "http://localhost:" + PORT;
  console.log("\n  U1 Print Hub  v" + VERSION + "  →  " + url);
  console.log("  Folder:   " + FOLDER);
  console.log("  Config:   " + CONFIG_PATH);
  console.log("  Printers: " + (PRINTERS.map(p => p.name).join(", ") || "(none configured — open the page and use Settings)") + "\n");
  if (IS_PKG) {
    // Double-click launch: open the browser for the user.
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    try { require("child_process").exec(cmd); } catch {}
  }
});
