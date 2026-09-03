// test/mock-moonraker.js — simulated Moonraker printers for harness testing.
//
// Two profiles, matching the two printer classes 2.9 must handle:
//   "u1"      — Snapmaker U1-style: print_task_config present (4 heads, colors,
//               the port-80 quirk is irrelevant here — the Hub reads the port
//               from the printer URL either way).
//   "generic" — stock Klipper/Moonraker (Sovol SV06 Plus ACE profile): serves
//               on :7125 in real life, NO print_task_config, single extruder.
//
// This mock exists so Workstream A's plumbing (type routing, upload routing,
// capability detection, class guard) can be harness-verified BEFORE the real
// SV06 Plus ACE lands. Per Rule #1 the live check still gates the release —
// this file makes sure the only thing left to verify on hardware is hardware.

"use strict";

const http = require("http");

function createMock(profile) {
  const state = {
    profile,                       // "u1" | "generic"
    printState: "standby",
    filename: "",
    uploads: [],                   // { filename, bytes }
    gcodeScripts: [],              // raw scripts received
    files: [],                     // onboard listing
    dropColorWrites: false,        // v2.10: simulate firmware silently refusing a
                                   // color write, so the Hub's read-back-verify
                                   // honesty can be proven (it must 502, not lie)
    dropTypeWrites: false          // v2.22.1: same knob for the material write
  };

  const objectsList = profile === "u1"
    ? ["print_stats", "display_status", "virtual_sdcard", "heater_bed", "exclude_object", "print_task_config", "extruder", "extruder1", "extruder2", "extruder3"]
    : ["print_stats", "display_status", "virtual_sdcard", "heater_bed", "exclude_object", "extruder"];

  const ptc = { // U1-only object
    filament_exist: [true, true, false, false],
    filament_color_rgba: ["FF0000FF", "00FF00FF", null, null],
    filament_type: ["PLA", "PLA", null, null],
    filament_sub_type: ["NONE", "SnapSpeed", null, null],
    filament_official: [false, true, false, false],
    filament_vendor: ["NONE", "Snapmaker", null, null],
    filament_sku: [null, 900002, null, null],
    filament_edit: [true, false, true, true]
  };
  state.ptc = ptc;                 // v2.10: let the harness inspect/verify live

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (u.pathname === "/printer/objects/list")
      return send(200, { result: { objects: objectsList } });

    if (u.pathname === "/printer/objects/query") {
      const want = [...u.searchParams.keys()];
      const status = {};
      if (want.some(k => k.startsWith("print_stats")))
        status.print_stats = { state: state.printState, filename: state.filename };
      if (want.some(k => k.startsWith("print_task_config")) && profile === "u1")
        status.print_task_config = ptc;
      if (want.some(k => k.startsWith("display_status"))) status.display_status = { progress: 0 };
      if (want.some(k => k.startsWith("virtual_sdcard"))) status.virtual_sdcard = { progress: 0 };
      if (want.some(k => k.startsWith("heater_bed"))) status.heater_bed = { temperature: 25, target: 0 };
      if (want.some(k => k.startsWith("exclude_object"))) status.exclude_object = {};
      return send(200, { result: { status } });
    }

    if (u.pathname === "/server/files/list")
      return send(200, { result: state.files.map(f => ({ path: f.name, size: f.size, modified: Date.now() / 1000, permissions: "rw" })) });

    if (u.pathname === "/server/files/upload" && req.method === "POST") {
      let bytes = 0;
      let head = Buffer.alloc(0);
      req.on("data", c => { bytes += c.length; if (head.length < 4096) head = Buffer.concat([head, c]).slice(0, 4096); });
      req.on("end", () => {
        const m = /filename="([^"]+)"/.exec(head.toString("latin1"));
        const filename = m ? m[1] : "unknown";
        state.uploads.push({ filename, bytes });
        state.files.push({ name: filename, size: bytes });
        send(201, { result: { item: { path: filename } } });
      });
      return;
    }

    if (u.pathname === "/printer/gcode/script" && req.method === "POST") {
      const script = u.searchParams.get("script") || "";
      state.gcodeScripts.push(script);
      // v2.10: apply color writes to print_task_config the way the firmware
      // does — empty trays and official (color-locked) spools silently refuse,
      // and the dropColorWrites knob refuses everything. The Hub must catch
      // every refusal via its read-back, never by trusting the write.
      if (profile === "u1" && /SET_PRINT_FILAMENT_CONFIG/.test(script)) {
        const im = /CONFIG_EXTRUDER='?(\d)'?/.exec(script);
        const cm = /FILAMENT_COLOR_RGBA='?([0-9A-Fa-f]{8})'?/.exec(script);
        if (im && cm && !state.dropColorWrites) {
          const i = Number(im[1]);
          if (ptc.filament_exist[i] && ptc.filament_edit[i] !== false)
            ptc.filament_color_rgba[i] = cm[1].toUpperCase();
        }
        // v2.22.1: the material write, same rules. dropTypeWrites models a
        // firmware that silently ignores FILAMENT_TYPE — the Hub must report
        // that honestly from the read-back, never from the 200 on the write.
        const tm = /FILAMENT_TYPE='?([A-Za-z+]+)'?/.exec(script);
        const sm = /FILAMENT_SUB_TYPE='?([^']*)'?/.exec(script);
        if (im && tm && !state.dropTypeWrites) {
          const i = Number(im[1]);
          if (ptc.filament_exist[i] && ptc.filament_edit[i] !== false) {
            ptc.filament_type[i] = tm[1].toUpperCase();
            if (sm) ptc.filament_sub_type[i] = sm[1] || "NONE";
          }
        }
      }
      if (/^SDCARD_PRINT_FILE/.test(script)) {
        state.printState = "printing";
        const fm = /FILENAME="([^"]+)"/.exec(script);
        state.filename = fm ? fm[1] : "";
      }
      return send(200, { result: "ok" });
    }

    if (u.pathname === "/machine/system_info")
      return send(200, { result: { system_info: { product_info: { device_name: profile === "u1" ? "U1-mock" : "SV06-mock", machine_type: profile, serial_number: "MOCK" + profile }, network: {} } } });

    if (u.pathname === "/server/files/metadata")
      return send(200, { result: {} });

    // v2.21 fixture, for the Klipper reverse proxy only: reflect what actually
    // arrived. The proxy relays a raw stream, and the failure it must rule out
    // is core's express.json() having already drained the body — a defect that
    // is invisible from status codes alone, because an empty POST still
    // succeeds. Echoing method, content-type and the exact bytes makes it
    // visible. Deliberately not a Moonraker route: nothing but the proxy test
    // may depend on it.
    if (u.pathname === "/__echo") {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => send(200, {
        method: req.method,
        contentType: req.headers["content-type"] || "",
        host: req.headers.host || "",
        cookie: req.headers.cookie || "",
        query: u.search || "",
        bytes: Buffer.byteLength(body),
        body
      }));
      return;
    }

    send(404, { error: "mock: no route " + u.pathname });
  });

  return {
    state,
    listen: port => new Promise(r => server.listen(port, "127.0.0.1", () => r(server.address().port))),
    close: () => new Promise(r => server.close(r))
  };
}

module.exports = { createMock };
