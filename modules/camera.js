// modules/camera.js — chamber camera (v2.11 module; code moved verbatim from
// server.js, hardware-verified 2026-08-05: the U1 cam streams only through
// Snapmaker's camera.* plugin on a dedicated socket — see the notes below).
// Behavior identical to 2.10 when enabled (the default); features.camera=false
// removes /api/camera and never opens a camera socket.

"use strict";

function register(ctx) {
  // ---- Chamber camera (Snapmaker camera.* plugin) ----------------------------
  // Hardware-verified 2026-08-05 (.88/.83): the U1's built-in chamber cam is NOT on
  // any standard Moonraker webcam interface (/server/webcams/list empty, /webcam/
  // 502, :8080 refused). It streams through Snapmaker's own plugin:
  // camera.start_monitor {domain:"lan", interval:0} makes the plugin write ~1 fps
  // JPEGs to /server/files/camera/monitor.jpg (fetched over plain HTTP);
  // camera.stop_monitor ends it. Stream test confirmed continuous frames, first
  // frame ~1.1s after start.
  //
  // The monitor must run on a DEDICATED socket — issuing start_monitor on the
  // shared fleet-subscription socket does NOT take (verified: frames never
  // advanced). So each printer gets its own lazy camera socket, opened on first
  // snapshot request and closed by the idle reaper when no card is watching.
  const CAM = new Map(); // idx -> { ws, open, monitoring, lastReq, startedAt, cooldownUntil }
  const CAM_COOLDOWN_MS = 5000;   // plugin misbehaves if start_monitor is hammered
  const CAM_IDLE_MS = 60000;      // stop the stream after this long with no viewers
  const CAM_WARMUP_MS = 1400;     // first frame lands ~1.1s after start
  const INFLIGHT = new Map();     // idx -> Promise<Buffer|null>, the grab everyone waiting shares (v2.35)

  function camConnect(idx) {
    const p = ctx.printers[idx];
    if (!p || typeof WebSocket === "undefined") return null;
    let c = CAM.get(idx);
    if (c && c.ws && (c.ws.readyState === 0 || c.ws.readyState === 1)) return c; // connecting/open
    if (c && Date.now() < c.cooldownUntil) return c;                              // throttle reconnect
    c = c || { ws: null, open: false, monitoring: false, lastReq: 0, startedAt: 0, cooldownUntil: 0 };
    const wsUrl = String(p.url).replace(/\/+$/, "").replace(/^http/, "ws") + "/websocket";
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { c.cooldownUntil = Date.now() + CAM_COOLDOWN_MS; CAM.set(idx, c); return c; }
    c.ws = ws; c.open = false; c.monitoring = false; c.cooldownUntil = Date.now() + CAM_COOLDOWN_MS;
    ws.onopen = () => {
      c.open = true; c.startedAt = Date.now();
      try { ws.send(JSON.stringify({ jsonrpc: "2.0", method: "camera.start_monitor", params: { domain: "lan", interval: 0 }, id: 900 })); c.monitoring = true; } catch {}
    };
    ws.onmessage = (ev) => {
      let j; try { j = JSON.parse(ev.data); } catch { return; }
      if (j.method === "notify_camera_status_change" && Array.isArray(j.params) && j.params[0]) c.monitoring = !!j.params[0].monitoring;
    };
    ws.onerror = () => {};
    ws.onclose = () => { c.open = false; c.monitoring = false; };
    CAM.set(idx, c);
    return c;
  }
  // Ensure a live stream; returns true if this call had to (re)start it (cold).
  function camEnsure(idx) {
    const prev = CAM.get(idx);
    const cold = !(prev && prev.open && prev.monitoring);
    const c = camConnect(idx);
    if (c) c.lastReq = Date.now();
    return cold;
  }
  function camStop(idx) {
    const c = CAM.get(idx);
    if (!c || !c.ws) return;
    try { if (c.open) c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "camera.stop_monitor", params: { domain: "lan" }, id: 901 })); } catch {}
    try { c.ws.close(); } catch {}
    c.open = false; c.monitoring = false; c.ws = null;
  }
  // Idle reaper: drop any camera socket nobody has watched for CAM_IDLE_MS.
  setInterval(() => {
    const now = Date.now();
    for (const [idx, c] of CAM) if (c.ws && now - c.lastReq > CAM_IDLE_MS) camStop(idx);
  }, 15000);


  // ---- Live chamber snapshot -------------------------------------------------
  // The browser polls this per printer on a staggered interval and points an <img>
  // at it. Ensures the plugin's monitor is running (starting it on first request),
  // then proxies the latest frame. A cold start needs ~1s for the first frame, so
  // we retry monitor.jpg once on a miss. Returns 503 (not 500) when there's simply
  // no frame yet, so the UI can show a retryable placeholder rather than an error.
  ctx.app.get("/api/camera", async (req, res) => {
    const idx = +req.query.id;
    const p = ctx.printers[idx];
    if (!p) return res.status(400).end();
    if (typeof WebSocket === "undefined") return res.status(503).json({ error: "no WebSocket client" });
    const cold = camEnsure(idx);   // opens the dedicated camera socket if needed
    const base = String(p.url).replace(/\/+$/, "");
    const grab = async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3500);
      try {
        const r = await fetch(base + "/server/files/camera/monitor.jpg", { signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) return null;
        const b = Buffer.from(await r.arrayBuffer());
        return (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) ? b : null; // valid JPEG SOI
      } catch { clearTimeout(to); return null; }
    };
    // On a cold start the stream needs ~1.1s to write its first frame; without the
    // wait we'd serve the stale monitor.jpg left on disk. Warm streams skip this.
    // v2.35 (issue #4): one grab per printer at a time. Every browser tab and
    // every tile asking for the same printer while a grab is running gets that
    // grab's frame, so a slow camera is asked once, not once per request piled
    // up behind it - the pile is what the printer's little file server choked on.
    let job = INFLIGHT.get(idx);
    if (!job) {
      job = (async () => {
        if (cold) await new Promise(r => setTimeout(r, CAM_WARMUP_MS));
        let jpg = await grab();
        if (!jpg) { await new Promise(r => setTimeout(r, 800)); jpg = await grab(); }
        return jpg;
      })().finally(() => { if (INFLIGHT.get(idx) === job) INFLIGHT.delete(idx); });
      INFLIGHT.set(idx, job);
    }
    const jpg = await job;
    if (!jpg) return res.status(503).json({ error: "no frame" });
    res.set("Cache-Control", "no-store").type("jpeg").send(jpg);
  });

}

module.exports = { register };
