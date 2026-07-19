// tunnel.js — Hub-managed Cloudflare tunnel for the U1 Print Hub.
//
// Why: HTTPS is the gate in front of everything on the v2.7 roadmap — the
// PWA can only fully install from a secure origin, NFC/QR filament scanning
// needs the Web NFC / camera APIs (secure-context only), and remote access
// should not mean port-forwarding a plain-HTTP dashboard to the internet.
// A Cloudflare tunnel gives us all of that with zero router configuration:
// cloudflared dials OUT to Cloudflare, so no ports are opened on the LAN.
//
// The Hub manages the whole lifecycle: it downloads the official cloudflared
// binary from Cloudflare's GitHub releases (saved next to the Hub, never
// bundled — it's ~40 MB and GPL-adjacent licensing stays clean), spawns it
// as a child process, reads the public URL out of its log stream, and shows
// live status in Settings. No new npm dependencies; the .tgz the Mac builds
// ship in is unpacked with Node's built-in zlib plus a minimal tar walk
// (same spirit as the pure-Node ZIP reader in fs-colors.js).
//
// Two modes (persisted in tunnel.json next to config.json):
//   "quick" — TryCloudflare. Zero accounts, zero config. Cloudflare issues a
//             random https://<words>.trycloudflare.com URL that lives only as
//             long as the process. Great for remote checking on a print from
//             anywhere; NOT a stable origin, so the PWA install / NFC story
//             needs token mode. Cloudflare offers no SLA on quick tunnels.
//   "token"  — a named tunnel the user creates once in the Cloudflare Zero
//             Trust dashboard (needs a free Cloudflare account + a domain).
//             Stable hostname → real PWA installs, bookmarkable, NFC-ready.
//             We run `cloudflared tunnel run --token <...>`; the hostname is
//             configured on Cloudflare's side, so the user pastes it here
//             purely for display.
//
// SAFETY INTERLOCK: starting a tunnel publishes the Hub to the public
// internet. The Hub refuses to start one unless the password gate is on
// (auth.json mode === "password"). "open" is obvious; "proxy"/"forward" are
// also refused because the tunnel points straight at the Hub's port and
// BYPASSES the user's reverse proxy — their proxy auth never runs. This is
// a hard rule, not a confirm-box: people who want an unauthenticated public
// printer farm can run cloudflared by hand.
//
// tunnel.json: { mode, token, hostname, autostart }.  The token is a
// credential — status/API responses only ever say tokenSet:true, never echo
// it. tunnel.json and the cloudflared binary must be gitignored.
//
// Verified against real cloudflared 2026.7.1 output:
//   URL line:   "INF |  https://<random-words>.trycloudflare.com ..."
//   Connected:  "INF Registered tunnel connection connIndex=..."
//   Hard fail:  "INF precheck complete hard_fail=true" (egress blocked)
// The URL can appear BEFORE the connection is proven, so status reports
// url and connected separately — the UI shows the URL as pending until a
// connection registers.

"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const zlib = require("zlib");

const RELEASE_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const LOG_KEEP = 80;          // ring buffer of recent cloudflared log lines
const LOG_LINE_MAX = 300;     // per-line cap so status payloads stay small

module.exports = function mountTunnel(app, express, baseDir, hubPort) {
  const TUNNEL_PATH = path.join(baseDir, "tunnel.json");
  const AUTH_PATH = path.join(baseDir, "auth.json");
  const BIN_PATH = path.join(baseDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

  // ---- persisted config ----
  let T = load();
  function load() {
    try { return JSON.parse(fs.readFileSync(TUNNEL_PATH, "utf8")); }
    catch { return { mode: "quick", token: "", hostname: "", autostart: false }; }
  }
  function save() {
    try { fs.writeFileSync(TUNNEL_PATH, JSON.stringify(T, null, 2)); } catch {}
  }

  // ---- runtime state (never persisted) ----
  let child = null;          // the cloudflared process, or null
  let state = "off";         // off | starting | running | stopped | error
  let url = "";              // quick-tunnel public URL once seen in the log
  let connected = false;     // "Registered tunnel connection" seen
  let startedAt = 0;
  let exitInfo = "";         // human-readable last exit / error
  let logRing = [];
  let stopping = false;      // distinguishes our kill from a crash

  function pushLog(line) {
    line = String(line).slice(0, LOG_LINE_MAX);
    logRing.push(line);
    if (logRing.length > LOG_KEEP) logRing.shift();
  }

  // ---- binary management ----
  function assetName() {
    const p = process.platform, a = process.arch;
    if (p === "win32") return a === "ia32" ? "cloudflared-windows-386.exe" : "cloudflared-windows-amd64.exe";
    if (p === "darwin") return a === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
    // linux
    if (a === "arm64") return "cloudflared-linux-arm64";
    if (a === "arm") return "cloudflared-linux-arm";
    return "cloudflared-linux-amd64";
  }

  // GitHub's /latest/download/ answers with a 302 to the asset CDN; Node's
  // https module does not follow redirects, so we do (cap of 5).
  function fetchBinary(urlStr, hops, cb) {
    if (hops > 5) return cb(new Error("Too many redirects"));
    https.get(urlStr, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchBinary(res.headers.location, hops + 1, cb);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return cb(new Error("Download failed: HTTP " + res.statusCode));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
      res.on("error", cb);
    }).on("error", cb);
  }

  // Minimal tar reader for the Mac .tgz builds: 512-byte headers, filename in
  // bytes 0-99, size as octal ASCII in bytes 124-135, data padded to 512.
  // The tarball contains a single file named "cloudflared".
  function untarSingle(tgzBuf, wantName) {
    const tar = zlib.gunzipSync(tgzBuf);
    let off = 0;
    while (off + 512 <= tar.length) {
      const name = tar.slice(off, off + 100).toString("utf8").replace(/\0.*$/, "");
      if (!name) break; // two zero blocks end the archive
      const size = parseInt(tar.slice(off + 124, off + 136).toString("utf8").trim(), 8) || 0;
      const dataStart = off + 512;
      if (name === wantName || name.endsWith("/" + wantName)) {
        return tar.slice(dataStart, dataStart + size);
      }
      off = dataStart + Math.ceil(size / 512) * 512;
    }
    throw new Error("'" + wantName + "' not found in archive");
  }

  function binaryVersion(cb) {
    if (!fs.existsSync(BIN_PATH)) return cb(null, "");
    let out = "";
    let p;
    try { p = spawn(BIN_PATH, ["--version"], { windowsHide: true }); }
    catch (e) { return cb(e); }
    p.stdout.on("data", (d) => out += d);
    p.on("error", (e) => cb(e));
    p.on("close", () => {
      const m = out.match(/version\s+(\S+)/);
      cb(null, m ? m[1] : out.trim().slice(0, 40));
    });
  }

  // ---- process lifecycle ----
  function authMode() {
    try { return (JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")).mode) || "open"; }
    catch { return "open"; }
  }

  function startTunnel(res) {
    if (child) return res && res.status(409).json({ error: "Tunnel is already running" });

    // The interlock comes FIRST — secure the Hub before anything else.
    // See design notes at the top of this file.
    const am = authMode();
    if (am !== "password") {
      const why = am === "open"
        ? "Set a Hub password first — a tunnel makes the Hub reachable from the public internet."
        : "Auth mode '" + am + "' relies on your reverse proxy, but the tunnel bypasses that proxy. Switch the Hub to password mode before tunneling.";
      return res && res.status(409).json({ error: why });
    }

    if (!fs.existsSync(BIN_PATH))
      return res && res.status(409).json({ error: "cloudflared is not downloaded yet" });
    if (T.mode === "token" && !T.token)
      return res && res.status(409).json({ error: "Token mode is selected but no token is saved" });

    const args = T.mode === "token"
      ? ["tunnel", "run", "--token", T.token]
      : ["tunnel", "--url", "http://127.0.0.1:" + hubPort, "--no-autoupdate"];

    url = ""; connected = false; exitInfo = ""; logRing = []; stopping = false;
    state = "starting"; startedAt = Date.now();

    try { child = spawn(BIN_PATH, args, { windowsHide: true }); }
    catch (e) {
      state = "error"; exitInfo = "Failed to launch: " + e.message;
      return res && res.status(500).json({ error: exitInfo });
    }

    const onLine = (line) => {
      if (!line.trim()) return;
      pushLog(line);
      if (!url) {
        const m = line.match(URL_RE);
        if (m) url = m[0];
      }
      if (/Registered tunnel connection/.test(line)) { connected = true; state = "running"; }
      if (/precheck complete hard_fail=true/.test(line))
        exitInfo = "Cloudflare edge unreachable — a firewall may be blocking outbound port 7844 (QUIC/UDP) and HTTPS to argotunnel.com.";
    };
    let buf = { out: "", err: "" };
    const feed = (which) => (d) => {
      buf[which] += d;
      let i;
      while ((i = buf[which].indexOf("\n")) >= 0) {
        onLine(buf[which].slice(0, i));
        buf[which] = buf[which].slice(i + 1);
      }
    };
    child.stdout.on("data", feed("out"));
    child.stderr.on("data", feed("err")); // cloudflared logs to stderr
    child.on("error", (e) => { exitInfo = "Process error: " + e.message; });
    child.on("close", (code) => {
      child = null;
      connected = false;
      if (stopping) { state = "stopped"; exitInfo = exitInfo || "Stopped."; }
      else {
        state = "error";
        exitInfo = exitInfo || ("cloudflared exited unexpectedly (code " + code + ")");
      }
      url = T.mode === "token" ? url : ""; // quick URLs die with the process
    });

    if (res) res.json({ ok: true, state });
  }

  function stopTunnel(res) {
    if (!child) { state = "off"; return res && res.json({ ok: true, state }); }
    stopping = true;
    try { child.kill(); } catch {}
    if (res) res.json({ ok: true, state: "stopping" });
  }

  // Never leave an orphaned cloudflared publishing the Hub after we're gone.
  const reap = () => { if (child) { try { child.kill(); } catch {} } };
  process.on("exit", reap);
  process.on("SIGINT", () => { reap(); process.exit(0); });
  process.on("SIGTERM", () => { reap(); process.exit(0); });

  // ---- API (mounted after the auth gate, so all of this requires login) ----
  app.get("/api/tunnel/status", (req, res) => {
    binaryVersion((e, ver) => {
      res.json({
        state, connected,
        mode: T.mode,
        url: T.mode === "token" ? (T.hostname ? "https://" + T.hostname : "") : url,
        autostart: !!T.autostart,
        tokenSet: !!T.token,
        hostname: T.hostname || "",
        binary: { present: fs.existsSync(BIN_PATH), version: e ? "" : ver },
        startedAt, error: exitInfo,
        authMode: authMode(),
        log: logRing.slice(-15),
      });
    });
  });

  // Body: { mode: "quick"|"token", token?, hostname?, autostart? }
  // Changing config while running does not touch the live process; the UI
  // tells the user to restart the tunnel to apply.
  app.post("/api/tunnel/config", (req, res) => {
    const { mode, token, hostname, autostart } = req.body || {};
    if (mode !== undefined) {
      if (!["quick", "token"].includes(mode)) return res.status(400).json({ error: "Bad mode" });
      T.mode = mode;
    }
    if (token !== undefined) T.token = String(token).trim();
    if (hostname !== undefined)
      T.hostname = String(hostname).trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (autostart !== undefined) T.autostart = !!autostart;
    save();
    res.json({ ok: true, mode: T.mode, tokenSet: !!T.token, hostname: T.hostname, autostart: T.autostart });
  });

  app.post("/api/tunnel/download", (req, res) => {
    const asset = assetName();
    fetchBinary(RELEASE_BASE + asset, 0, (err, buf) => {
      if (err) return res.status(502).json({ error: "Download failed: " + err.message });
      try {
        const bin = asset.endsWith(".tgz") ? untarSingle(buf, "cloudflared") : buf;
        // write-then-rename so a half-written binary is never left in place
        const tmp = BIN_PATH + ".part-" + crypto.randomBytes(4).toString("hex");
        fs.writeFileSync(tmp, bin);
        if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
        fs.renameSync(tmp, BIN_PATH);
      } catch (e) {
        return res.status(500).json({ error: "Could not save binary: " + e.message });
      }
      binaryVersion((e, ver) => {
        if (e || !ver) return res.status(500).json({ error: "Downloaded binary failed to run" + (e ? ": " + e.message : "") });
        res.json({ ok: true, version: ver, path: BIN_PATH });
      });
    });
  });

  app.post("/api/tunnel/start", (req, res) => startTunnel(res));
  app.post("/api/tunnel/stop", (req, res) => stopTunnel(res));

  // ---- autostart on Hub boot ----
  if (T.autostart) {
    setTimeout(() => {
      if (!child && fs.existsSync(BIN_PATH)) startTunnel(null);
    }, 3000); // give the Hub's listener a moment first
  }
};
