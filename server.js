// server.js — U1 Print Hub  ·  v2.5.0
// Watches a folder of sliced gcode, shows the toolhead/color map per file,
// and pushes the chosen file to the chosen printer via Moonraker (server-side,
// so no browser CORS headaches).

const VERSION = "2.23.2";

const fs = require("fs");
const http = require("http");
const path = require("path");
// v2.23: the core is split into core/*.js. Every file receives the same `hub`
// object and runs in this exact order — the order the code had in the old
// single file, which load-time statements (loadConfig, middleware, listen)
// depend on. Shared mutable state (CFG, FOLDER, PRINTERS, TYPES, TYPE_WARNINGS, FEATURES, QUEUE, FARM_READY) lives on hub.
const hub = { VERSION };
require("./core/log.js")(hub);
require("./core/config.js")(hub);
require("./core/records.js")(hub);
require("./core/app.js")(hub);
require("./core/library.js")(hub);
require("./core/print.js")(hub);
require("./core/fleet.js")(hub);
require("./core/telemetry.js")(hub);
require("./core/thumbs.js")(hub);
require("./core/filament.js")(hub);
require("./core/network.js")(hub);
require("./core/settings.js")(hub);
require("./core/modules.js")(hub);
const { BASE_DIR, CONFIG_PATH, IS_PKG, PORT, UPGRADE_HANDLERS, app, hublog } = hub;


const SERVER = app.listen(PORT, () => {
  const url = "http://localhost:" + PORT;
  console.log("\n  U1 Print Hub  v" + VERSION + "  →  " + url);
  console.log("  Folder:   " + hub.FOLDER);
  console.log("  Config:   " + CONFIG_PATH);
  console.log("  Printers: " + (hub.PRINTERS.map(p => p.name).join(", ") || "(none configured — open the page and use Settings)") + "\n");
  if (IS_PKG) {
    // Double-click launch: open the browser for the user.
    const cmd = process.platform === "win32" ? `start "" "${url}"`
      : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
    try { require("child_process").exec(cmd); } catch {}
  }
});


// v2.21: WebSocket upgrades. Express never sees these — Node emits 'upgrade' on
// the server and hands over the raw socket — so any module that needs one
// registers a handler through ctx.onUpgrade during startup, and they are wired
// here once the server exists.
//
// A handler returns true if it took the socket. Nothing claimed is CLOSED, not
// ignored: an unanswered upgrade leaves the browser waiting on a socket that
// will never speak, which looks exactly like a hung printer.
// v2.21: last-resort crash evidence. Production died on 2026-09-01 with its
// stack in a console window nobody was watching, and the only symptom was
// Cloudflare 502s on a phone. An uncaught exception still ends the process —
// continuing on unknown state would be worse — but it now ends it with the
// stack ON DISK, timestamped, where the next session can read it.
process.on("uncaughtException", (e) => {
  const line = new Date().toISOString() + "  UNCAUGHT  " + (e && e.stack || e) + "\n\n";
  try { fs.appendFileSync(path.join(BASE_DIR, "crash.log"), line); } catch {}
  try { console.error(line); } catch {}
  process.exit(1);
});

process.on("unhandledRejection", (e) => {
  const line = new Date().toISOString() + "  UNHANDLED REJECTION  " + (e && e.stack || e) + "\n\n";
  try { fs.appendFileSync(path.join(BASE_DIR, "crash.log"), line); } catch {}
  try { console.error(line); } catch {}
  // Rejections don't kill the process on current Node defaults; log and live.
});


SERVER.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});   // a client that walks away mid-handshake is not an event
  for (const h of UPGRADE_HANDLERS) {
    try { if (h(req, socket, head) === true) return; }
    catch (e) { hublog("error", "upgrade handler failed: " + e.message); break; }
  }
  try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); } catch {}
  try { socket.destroy(); } catch {}
});

