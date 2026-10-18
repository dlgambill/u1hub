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
    dropTypeWrites: false,         // v2.22.1: same knob for the material write
    history: [],                   // v2.33: Moonraker job history, newest first:
                                   // { filename, status, start_time, print_duration }
    camGrabs: 0,                   // v2.35: monitor.jpg fetches seen (issue #4: one per grab, not per viewer)
    camDelayMs: 600,               // how long the "camera" takes to answer
    stallUpload: false,            // 2.42 (H3): accept an upload, then stop reading it and never answer
    stallScripts: false,           // 2.42 (H3): accept a gcode script and never answer
    stallDownload: false,          // 2.43 (H20): start sending a stored file, then stop mid-body
    queries: 0,                    // 2.45 (H10): /printer/objects/query hits - proves one snapshot loop, not four
    statsOnlyQueries: 0,           // 2.45 (H10): ...of which asked for print_stats alone (the old watcher's own probe)
    metaFetches: 0,                // 2.45 (H17): /server/files/metadata hits - proves thumbnails do not evict the fleet's cache
    held: []                       // requests parked by the two knobs above
  };
  // Let go of every parked request (the harness calls this after a stall test).
  state.releaseHeld = () => { for (const r of state.held.splice(0)) { try { r.socket && r.socket.destroy(); } catch {} } };

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
      state.queries++;
      const want = [...u.searchParams.keys()];
      if (want.length === 1 && want[0] === "print_stats") state.statsOnlyQueries++;
      const status = {};
      if (want.some(k => k.startsWith("print_stats"))) {
        status.print_stats = { state: state.printState, filename: state.filename, message: state.printMessage || "",
          print_duration: state.printDuration || 0 };
        // v2.23: Snapmaker's fork reports detector pauses here, not in .message
        // (shape captured live from U2, 2026-09-08).
        if (state.exception) status.print_stats.exception = state.exception;
      }
      if (want.some(k => k.startsWith("print_task_config")) && profile === "u1")
        status.print_task_config = ptc;
      if (want.some(k => k.startsWith("display_status"))) status.display_status = { progress: 0 };
      // 2.45 (H17): a real printer reports the running file's size and byte
      // position; the Hub's progress math keys its metadata cache on the size.
      if (want.some(k => k.startsWith("virtual_sdcard"))) status.virtual_sdcard = state.printState === "printing" || state.printState === "paused"
        ? { progress: 0, file_size: 123456, file_position: 0, file_path: state.filename } : { progress: 0 };
      if (want.some(k => k.startsWith("heater_bed"))) status.heater_bed = { temperature: 25, target: 0 };
      if (want.some(k => k.startsWith("exclude_object"))) status.exclude_object = {};
      return send(200, { result: { status } });
    }

    if (u.pathname === "/server/files/list")
      return send(200, { result: state.files.map(f => ({ path: f.name, size: f.size, modified: Date.now() / 1000, permissions: "rw" })) });

    // v2.40.2: download a stored file (copy-to-Hub). Bytes are the file's own
    // `data` when the test gave one, else `size` deterministic bytes.
    if (u.pathname.startsWith("/server/files/gcodes/") && req.method === "GET") {
      const name = decodeURIComponent(u.pathname.slice("/server/files/gcodes/".length));
      const f = state.files.find(x => x.name === name);
      if (!f) return send(404, { error: "not found" });
      const body = f.data || Buffer.alloc(f.size || 0, 0x47);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      if (state.stallDownload) {                 // a printer that goes quiet mid-download
        res.write(body.subarray(0, Math.min(65536, body.length)));
        state.held.push(req); return;
      }
      return res.end(body);
    }

    if (u.pathname === "/server/files/upload" && req.method === "POST" && state.stallUpload) {
      req.pause(); state.held.push(req); return;     // a printer that stops reading
    }
    if (u.pathname === "/printer/gcode/script" && req.method === "POST" && state.stallScripts) {
      state.held.push(req); return;                  // a printer that never answers
    }
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
        const tm = /FILAMENT_TYPE=('?)([A-Za-z+]+)\1/.exec(script);
        const sm = /FILAMENT_SUBTYPE=('?)([^' ]*)\1/.exec(script);
        // Hardware truth (U6, 2026-09-02): a type write WITHOUT VENDOR= is
        // refused — "[print_task_config] filament_config, incomplete
        // parameters" — and it raises a System Anomaly on the touchscreen.
        // Model the refusal so the harness catches any drift back to it.
        if (im && tm && !/(^|\s)VENDOR=/.test(script))
          return send(400, { error: { code: 400, message: "!! [print_task_config] filament_config, incomplete parameters" } });
        if (im && tm && !state.dropTypeWrites) {
          const i = Number(im[1]);
          if (ptc.filament_exist[i] && ptc.filament_edit[i] !== false) {
            ptc.filament_type[i] = tm[2].toUpperCase();
            if (sm) ptc.filament_sub_type[i] = sm[2] || "NONE";
            const vm = /(^|\s)VENDOR=('?)([^' ]+)\2/.exec(script);
            if (vm) ptc.filament_vendor[i] = vm[3];
          }
        }
      }
      // v2.41.1: the spool-tag re-read the firmware runs on a reboot, a load
      // or unload and feeder events (filament_detect.request_update_filament_info,
      // also reachable as FILAMENT_DT_UPDATE). For a head with no RFID tag,
      // print_task_config._rfid_filament_info_update_cb keeps the head's
      // settings ONLY if its vendor is not 'NONE'; otherwise the blank read
      // overwrites them with white / NONE. This is the rule that made Hub-set
      // colors "not save to the machine".
      if (profile === "u1" && /^FILAMENT_DT_UPDATE\b/.test(script)) {
        const ch = /CHANNEL=(\d)/.exec(script);
        const i = ch ? Number(ch[1]) : -1;
        if (i >= 0 && ptc.filament_exist[i] && !ptc.filament_official?.[i] && (ptc.filament_vendor[i] || "NONE") === "NONE") {
          ptc.filament_color_rgba[i] = "FFFFFFFF";
          ptc.filament_type[i] = "NONE";
          ptc.filament_vendor[i] = "NONE";
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

    if (u.pathname === "/server/files/metadata") {
      state.metaFetches++;
      return send(200, { result: {} });
    }

    // v2.35: the chamber camera's frame, as Snapmaker's plugin writes it. A
    // minimal JPEG (SOI ... EOI) after a delay, counted, so the harness can
    // prove the Hub asks once per grab however many viewers are waiting.
    if (u.pathname === "/server/files/camera/monitor.jpg" && profile === "u1") {
      state.camGrabs++;
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
      setTimeout(() => { res.writeHead(200, { "Content-Type": "image/jpeg" }); res.end(jpg); }, state.camDelayMs);
      return;
    }

    // v2.37: lifetime totals, which the logbook reads print hours from.
    if (u.pathname === "/server/history/totals")
      return send(200, { result: { job_totals: { total_jobs: state.history.length, total_time: state.totalPrintTime || 0,
        total_print_time: state.totalPrintTime || 0, total_filament_used: 0, longest_job: 0 } } });

    // v2.33: the job history the Models tab's "most printed" order counts
    // from. Shape as Moonraker answers it: { result: { count, jobs } }.
    if (u.pathname === "/server/history/list") {
      const limit = Number(u.searchParams.get("limit")) || 50;
      return send(200, { result: { count: state.history.length, jobs: state.history.slice(0, limit) } });
    }

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
