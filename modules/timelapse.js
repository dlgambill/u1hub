// modules/timelapse.js - print timelapses from the U1's own chamber camera
// (v2.34; v2.40: save to a folder of your choice).
//
// How it works:
//   1. "print.started" (core/events.js) opens the printer's chamber-camera
//      socket (the same camera.start_monitor plugin modules/camera.js uses
//      for live view - see there for the protocol notes) and polls
//      /printer/objects/query?print_stats every CAPTURE_POLL_MS. Each time
//      current_layer advances, one frame is grabbed from monitor.jpg.
//   2. "print.done" stops the poll and, if enough frames came in, runs
//      ffmpeg once to turn frame_000001.jpg, frame_000002.jpg, ... into a
//      silent .mp4 at CAPTURE_OUTPUT_FPS.
//   3. v2.40: that video is saved into the folder set under Settings >
//      Timelapses (config.json timelapse.saveDir) as
//      "<printer> - <gcode name> - <date time>.mp4".
//   4. Optional, advanced: when config.json's timelapseUpload block (older
//      name: sf3dTimelapse) carries an
//      uploadUrl and passcode, the video is also queued (surviving a Hub
//      restart) for a storefront upload - logo intro, product-photo outro,
//      POST to that endpoint. This is the pipeline the Hub was first built
//      for; it stays off unless both values are set by hand.
// "print.cancelled" / "print.error" stop the capture and throw the frames
// away. A Hub restart mid-print RESUMES capture into the same frame
// directory rather than starting over - see CAPTURE_STATE below.
//
// Off by default (MODULE_DEFAULTS.timelapse = false) - capturing polls the
// camera on every printing U1 - and it does nothing while there is nowhere
// for a finished video to go (no folder, no upload configured).
//
// Fails open everywhere. No config, no camera reachable, no ffmpeg, a
// network hiccup - each logs once and moves on. A missed timelapse is a
// shrug; a module that can crash the Hub mid-print, or stall a print job
// waiting on a frame grab, is not an acceptable trade for one. Capture runs
// on its own timer against the printer's own reported layer count - it
// never pauses or moves a print to get a frame.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

const MIN_DURATION_SEC = 1.5;           // guards against a 0-byte/corrupt
                                         // assembly, NOT a "too short to
                                         // care about" cutoff - under the old
                                         // firmware-rendered design Snapmaker
                                         // picked the length and 5s was a
                                         // sane corruption floor; now the Hub
                                         // itself decides frame count/fps
                                         // (see MIN_CAPTURE_FRAMES below,
                                         // which is what actually decides
                                         // "worth posting"), so a short but
                                         // valid capture must not get
                                         // rejected here
const QUEUE_FILE = "timelapse-queue.json"; // survives a Hub restart mid-upload

// ---- Chamber-camera frame capture (2026-09-24) ----
const CAPTURE_POLL_MS = 8000;           // how often to ask the printer for
                                         // its current layer while a print
                                         // the Hub is watching is running
const CAPTURE_QUERY_TIMEOUT_MS = 6000;  // per print_stats query
const CAPTURE_OUTPUT_FPS = 12;          // frame rate of the assembled clip -
                                         // NOT the polling rate; a tall print
                                         // with many layers plays back
                                         // faster than it printed, same as
                                         // any layer-driven timelapse
const MIN_CAPTURE_FRAMES = 8;           // fewer than this and there's no
                                         // real timelapse to show - discard
                                         // rather than post a near-static clip
const FRAMES_DIR_NAME = "timelapse-frames";   // per-job frame directories
const PENDING_DIR_NAME = "timelapse-pending"; // assembled-but-not-yet-uploaded .mp4s
const CAPTURE_STATE_FILE = "timelapse-capture-state.json"; // resume point for
                                         // an in-progress capture, so a Hub
                                         // restart mid-print continues the
                                         // SAME frame directory instead of
                                         // abandoning it - see the 2026-09-26
                                         // note below register()'s boot
                                         // catch-up for why this exists
const FRAME_GLOB = "frame_%06d.jpg";
const ORPHAN_FRAMES_MAX_AGE_MS = 24 * 60 * 60 * 1000; // a frame dir left over
                                         // from a crash is never going to
                                         // finish on its own - clean it up
                                         // instead of leaking disk forever

// Storefront uploads only (step 4 above): the video fades in from a logo
// (config.json timelapseUpload.logoFile, skipped if missing) and fades out to
// a still photo of the finished product, looked up from the upload
// endpoint's GET route by gcode_filename. A burned-in text call-to-action
// was tried in 2.31 and removed in 2.32.
const COMPOSE_FPS = 30;                // normalizes the still segments and
                                        // the re-encoded main clip to one
                                        // frame rate so concat below is a
                                        // plain stream copy, not a re-encode
const LOGO_HOLD_SEC = 1.5;             // intro: fade in, hold, fade out to
const LOGO_FADE_SEC = 0.5;             // black, then a hard cut to the video
const PHOTO_HOLD_SEC = 3;              // outro: hard cut from the video,
const PHOTO_FADE_SEC = 0.75;           // fade in from black, then hold
const COMPOSE_STEP_TIMEOUT_MS = 60000; // per ffmpeg step (3-4 short
                                        // re-encodes, never one long one)

// Reverse-engineered 2026-09-21 from all 169 existing storefront timelapse rows
// and regex-verified against every one of them (see test/timelapse-standalone.js):
// every character that is NOT [A-Za-z0-9_] becomes its OWN literal hyphen -
// runs are NOT collapsed into one - then leading/trailing hyphens are
// trimmed. Underscores pass through untouched.
//   "Bearded Dragon (Red Monster) x3.gcode" -> "Bearded-Dragon--Red-Monster--x3"
//   "bottom (1)_PLA_4h55m.gcode"             -> "bottom--1-_PLA_4h55m"
function slugify(gcodeFilename) {
  const base = String(gcodeFilename || "").replace(/\.gcode$/i, "");
  return base.replace(/[^A-Za-z0-9_]/g, "-").replace(/^-+|-+$/g, "");
}

// yyyyMMddTHHmmssZ in UTC - matches the existing printed_at column exactly.
function fmtPrintedAt(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return "" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) +
    "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
}

function buildR2Key(printer, gcodeFilename, printedAtStr) {
  const slug = slugify(gcodeFilename);
  return "timelapses/" + slug + "/" + printer + "_" + printedAtStr + "_" + slug + ".mp4";
}

// Scales+pads any input (the logo, the product photo, or the timelapse
// itself) onto a common W x H canvas without distorting its aspect ratio,
// then locks it to one frame rate/pixel format - this is what makes the
// concat step below a plain stream copy instead of a re-encode: every
// segment already agrees on codec parameters by the time it gets there.
function scaleFitFilter(width, height) {
  return "scale=" + width + ":" + height + ":force_original_aspect_ratio=decrease,pad=" + width + ":" + height +
    ":(ow-iw)/2:(oh-ih)/2,setsar=1,fps=" + COMPOSE_FPS + ",format=yuv420p";
}

// A still image (logo or product photo) held for holdSec, with an optional
// fade at either edge - "in", "out", "both", or "none". Returns the filter
// string AND the total clip duration together, since a fade adds fadeSec on
// top of the hold and the caller needs both the "-t" and "-vf" ffmpeg flags
// built from the same number rather than repeating this arithmetic at each
// call site.
function stillSegmentFilter(width, height, holdSec, fadeSec, fadeEdges) {
  const edges = fadeEdges === "both" ? 2 : fadeEdges === "none" ? 0 : 1;
  const duration = holdSec + fadeSec * edges;
  let filter = scaleFitFilter(width, height);
  if (fadeEdges === "in" || fadeEdges === "both") filter += ",fade=t=in:st=0:d=" + fadeSec;
  if (fadeEdges === "out" || fadeEdges === "both") filter += ",fade=t=out:st=" + (duration - fadeSec) + ":d=" + fadeSec;
  return { filter, duration };
}

// The timelapse itself gets no fade, only the scale/pad/fps/format
// normalization - it's already the held middle of the composited video.
function mainSegmentFilter(width, height) {
  return scaleFitFilter(width, height);
}

// ffmpeg argv builders - pure, so the "exactly one frame-rate mechanism"
// invariant below is unit-testable without spawning ffmpeg. 2026-09-24:
// the first shipped version of this pipeline ALSO passed a standalone "-r"
// flag alongside the filter graph's own "fps=" clause - two separate
// frame-rate conversions stacked on the same stream. Harmless on the still
// image loops (a duplicated identical frame looks the same either way), but
// on the real timelapse it visibly scrambled frames (it looked like "a
// demigorgan" with the product photo tacked on the end) - caught by
// actually watching the output, not by the probe-only checks this module's
// tests had relied on. Never add "-r" back here; scaleFitFilter/
// stillSegmentFilter's own "fps=" is the one and only place frame rate
// gets set.
function mainEncodeArgs(inPath, outPath, width, height) {
  return ["-y", "-i", inPath, "-vf", mainSegmentFilter(width, height),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", outPath];
}

function stillEncodeArgs(inPath, outPath, width, height, holdSec, fadeSec, fadeEdges) {
  const { filter, duration } = stillSegmentFilter(width, height, holdSec, fadeSec, fadeEdges);
  return {
    duration,
    args: ["-y", "-loop", "1", "-i", inPath, "-t", String(duration), "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", outPath],
  };
}

// frame_000001.jpg, frame_000042.jpg, ... - zero-padded so ffmpeg's image2
// sequence reader (assembleArgs below) walks them in capture order without
// any separate manifest/concat file, the same way the compose step above
// avoids one for its three segments.
function frameFileName(idx) {
  return "frame_" + String(idx).padStart(6, "0") + ".jpg";
}

// Turns a directory of frame_NNNNNN.jpg files into one silent .mp4 at fps.
// Pure/testable for the same reason mainEncodeArgs/stillEncodeArgs are: the
// 2026-09-24 "-r AND fps= at once" bug (see the big comment above) is exactly
// the kind of regression that hides in an argv nobody diffs. -framerate here
// is an INPUT flag - it tells the image2 demuxer how fast to read frames off
// disk - not a second, conflicting output frame-rate conversion; there is no
// "-r" anywhere in this list, deliberately, and there must never be one.
function assembleArgs(framesDir, outPath, fps) {
  return ["-y", "-framerate", String(fps), "-i", path.join(framesDir, FRAME_GLOB),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-an", outPath];
}

function register(ctx) {
  const queuePath = path.join(ctx.baseDir, QUEUE_FILE);
  const framesRoot = path.join(ctx.baseDir, FRAMES_DIR_NAME);
  const pendingDir = path.join(ctx.baseDir, PENDING_DIR_NAME);
  try { fs.mkdirSync(framesRoot, { recursive: true }); } catch {}
  try { fs.mkdirSync(pendingDir, { recursive: true }); } catch {}

  // Orphan sweep: a Hub crash mid-print leaves a frame directory nobody will
  // ever finish - not corrupt, just abandoned. A real in-progress capture
  // touches its directory every CAPTURE_POLL_MS (a few seconds), so anything
  // older than a day is certainly dead, not a print that's still running.
  try {
    for (const name of fs.readdirSync(framesRoot)) {
      const p = path.join(framesRoot, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory() && Date.now() - st.mtimeMs > ORPHAN_FRAMES_MAX_AGE_MS) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}

  function loadQueue() {
    try { return JSON.parse(fs.readFileSync(queuePath, "utf8")) || []; }
    catch { return []; }
  }

  // Same write-then-rename-with-fallback idiom as modules/dispatch.js's
  // save() - state here is local (not on the X: share), but the pattern
  // costs nothing and CLAUDE.md is explicit: don't reinvent it.
  let SAVE_FALLBACK = false;
  function saveQueue(items) {
    const data = JSON.stringify(items, null, 2);
    const tmp = queuePath + ".tmp";
    if (!SAVE_FALLBACK) {
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, queuePath); return; }
      catch (e) {
        SAVE_FALLBACK = true;
        ctx.hublog("warn", "timelapse: atomic save failed (" + e.code + " " + e.message +
          ") - falling back to a direct write for the rest of this run.");
      }
    }
    fs.writeFileSync(queuePath, data);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }

  // ---- Capture resume state (2026-09-26) ----
  // 2026-09-26: a real captured-and-uploaded timelapse was reported that
  // looked completely static - every sampled frame identical. Root cause:
  // the Hub had restarted several times that day (unrelated feature work,
  // each restart bumping the version) while that exact print was running.
  // Every restart's boot catch-up (below) saw the printer was still mid-job
  // and did what it always did - started a BRAND NEW capture directory from
  // frame_000001, discarding whatever had already been captured. The
  // orphaned directories from each abandoned attempt were still sitting on
  // disk, timestamped right at each restart. The video that finally got
  // uploaded only held the frames from the LAST restart to completion - a
  // 27-minute tail end of what was probably a much longer print, by which
  // point the parts already looked finished. A short timelapse beating none
  // (the original boot catch-up's reasoning) doesn't hold when it happens
  // on every single restart of a farm that gets restarted several times a
  // day - it adds up to "almost every video is just the tail end."
  //
  // The fix: persist enough state after every captured frame that a restart
  // can tell "this printer is still printing the SAME file I was already
  // capturing" and continue writing into the SAME directory, instead of
  // always starting over. Written locally (not the X: share) - same
  // tradeoff as timelapse-queue.json.
  const captureStatePath = path.join(ctx.baseDir, CAPTURE_STATE_FILE);
  function loadCaptureState() {
    try { return JSON.parse(fs.readFileSync(captureStatePath, "utf8")) || {}; }
    catch { return {}; }
  }
  let CAPTURE_STATE = loadCaptureState(); // printer name -> {dir, filename, frameIdx, lastLayer, startedAtMs}

  let STATE_SAVE_FALLBACK = false;
  function saveCaptureState() {
    const data = JSON.stringify(CAPTURE_STATE, null, 2);
    const tmp = captureStatePath + ".tmp";
    if (!STATE_SAVE_FALLBACK) {
      try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, captureStatePath); return; }
      catch (e) {
        STATE_SAVE_FALLBACK = true;
        ctx.hublog("warn", "timelapse: atomic capture-state save failed (" + e.code + " " + e.message +
          ") - falling back to a direct write for the rest of this run.");
      }
    }
    fs.writeFileSync(captureStatePath, data);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
  function persistCaptureState(state) {
    CAPTURE_STATE[state.printer] = {
      dir: state.dir, filename: state.filename, frameIdx: state.frameIdx,
      lastLayer: state.lastLayer, startedAtMs: state.startedAtMs,
    };
    saveCaptureState();
  }
  function clearCaptureStateEntry(printerName) {
    if (Object.prototype.hasOwnProperty.call(CAPTURE_STATE, printerName)) {
      delete CAPTURE_STATE[printerName];
      saveCaptureState();
    }
  }

  // ---- Chamber-camera frame capture ----
  const CAPTURE = new Map(); // printer name -> capture state

  function findPrinter(name) {
    return (ctx.printers || []).find((x) => x.name === name) || null;
  }

  // Same fetch-with-timeout-and-JPEG-SOI-check as modules/camera.js's own
  // /api/camera grab() - deliberately duplicated rather than shared, since
  // camera.js's version is wired to that module's own idle-reaped socket
  // lifecycle and importing across modules isn't how this codebase is split.
  async function grabFrame(base) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(base + "/server/files/camera/monitor.jpg", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) return null;
      const b = Buffer.from(await r.arrayBuffer());
      return (b.length > 2 && b[0] === 0xff && b[1] === 0xd8) ? b : null; // valid JPEG SOI
    } catch { clearTimeout(to); return null; }
  }

  async function readCurrentLayer(base) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), CAPTURE_QUERY_TIMEOUT_MS);
    try {
      const r = await fetch(base + "/printer/objects/query?print_stats", { signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      const layer = j && j.result && j.result.status && j.result.status.print_stats &&
        j.result.status.print_stats.info && j.result.status.print_stats.info.current_layer;
      return (typeof layer === "number") ? layer : null;
    } catch { clearTimeout(to); return null; }
  }

  // Dedicated per-printer websocket, same protocol modules/camera.js uses
  // for live view (camera.start_monitor {domain:"lan", interval:0} makes the
  // plugin write ~1fps JPEGs to monitor.jpg) - opened for the life of the
  // capture rather than idle-reaped, and reconnected once after a drop for
  // as long as state.active stays true.
  function capOpenSocket(state) {
    if (typeof WebSocket === "undefined") return;
    if (!state.active) return;
    const wsUrl = state.base.replace(/^http/, "ws") + "/websocket";
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    state.ws = ws;
    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "camera.start_monitor", params: { domain: "lan", interval: 0 }, id: 950 }));
      } catch {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      state.ws = null;
      if (state.active) setTimeout(() => { if (state.active) capOpenSocket(state); }, 5000);
    };
  }

  // One tick: read the printer's current layer, and if it advanced since
  // the last tick, grab a frame and save it. A read failure or an
  // unchanged layer is a normal, silent no-op - print_stats not answering
  // for one poll (a busy printer, a Wi-Fi blip) just means "try again in
  // CAPTURE_POLL_MS", not "stop capturing".
  async function capPollOnce(state) {
    if (!state.active) return;
    const layer = await readCurrentLayer(state.base);
    if (layer == null) return;
    const isFirst = typeof state.lastLayer !== "number";
    if (!isFirst && layer <= state.lastLayer) return;
    state.lastLayer = layer;
    const frame = await grabFrame(state.base);
    if (frame) {
      const idx = state.frameIdx + 1;
      try {
        fs.writeFileSync(path.join(state.dir, frameFileName(idx)), frame);
        state.frameIdx = idx;
      } catch (e) {
        ctx.hublog("warn", "timelapse: could not save a captured frame for " + state.printer + " - " + (e && e.message || e));
      }
    }
    // Persist even when the frame grab itself failed - the layer advanced
    // either way, and a restart right after a missed frame should not
    // re-request the same already-passed layer forever.
    persistCaptureState(state);
  }

  // Idempotent: a duplicate "print.started" for a printer already being
  // captured (shouldn't happen - core/events.js only emits it on a real
  // non-printing -> printing edge - but costs nothing to guard) is ignored
  // rather than starting a second, competing capture into a new directory.
  //
  // `resume` (2026-09-26), when given, continues an EXISTING frame
  // directory left behind by a Hub restart instead of creating a fresh one -
  // see the capture-resume-state comment above CAPTURE_STATE for why this
  // matters. It carries {dir, frameIdx, lastLayer, startedAtMs} as saved by
  // persistCaptureState(); only the boot catch-up passes it.
  function capStart(printerName, filename, resume) {
    if (CAPTURE.has(printerName)) return;
    const p = findPrinter(printerName);
    if (!p) {
      ctx.hublog("warn", "timelapse: can't start capture for " + printerName + " - it isn't in config.json");
      return;
    }
    const base = String(p.url).replace(/\/+$/, "");
    let dir, frameIdx, lastLayer, startedAtMs;
    if (resume) {
      ({ dir, frameIdx, lastLayer, startedAtMs } = resume);
    } else {
      const safe = String(printerName).replace(/[^A-Za-z0-9_-]/g, "_");
      dir = path.join(framesRoot, safe + "_" + Date.now());
      try { fs.mkdirSync(dir, { recursive: true }); }
      catch (e) {
        ctx.hublog("error", "timelapse: could not create a frame directory for " + printerName + " - " + (e && e.message || e));
        return;
      }
      frameIdx = 0; lastLayer = undefined; startedAtMs = Date.now();
    }
    const state = {
      printer: printerName, filename, base, dir,
      frameIdx, lastLayer, startedAtMs,
      ws: null, active: true, pollTimer: null,
    };
    CAPTURE.set(printerName, state);
    persistCaptureState(state);
    capOpenSocket(state);
    state.pollTimer = setInterval(() => {
      capPollOnce(state).catch((e) => ctx.hublog("warn", "timelapse: capture poll failed for " + printerName + " - " + (e && e.message || e)));
    }, CAPTURE_POLL_MS);
    if (state.pollTimer.unref) state.pollTimer.unref();
    if (resume) {
      ctx.hublog("info", "timelapse: resumed capture for " + printerName + "/" + filename +
        " after a Hub restart (" + frameIdx + " frame(s) already captured)");
    } else {
      ctx.hublog("info", "timelapse: capture started for " + printerName + "/" + filename);
    }
  }

  // Stops polling and tears down the socket; returns the (now-detached)
  // state so the caller decides what happens to the frames already on disk
  // - assembled (print.done) or discarded (cancelled/error/no capture).
  function capStop(printerName) {
    const state = CAPTURE.get(printerName);
    if (!state) return null;
    state.active = false;
    CAPTURE.delete(printerName);
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.ws) {
      try { state.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "camera.stop_monitor", params: { domain: "lan" }, id: 951 })); } catch {}
      try { state.ws.close(); } catch {}
    }
    return state;
  }

  function discardFrames(state) {
    if (!state) return;
    try { fs.rmSync(state.dir, { recursive: true, force: true }); } catch {}
  }

  // duration_seconds and frame_count are required by the storefront upload.
  // ffprobe ships with ffmpeg, but this still fails
  // open: a probe error returns zeros rather than dropping the video - a
  // wrong-but-present number beats losing the file outright. width/height
  // default to 1920x1080 rather than 0x0, since an all-zero scale target
  // would make ffmpeg reject the compositing filter outright instead of
  // just looking wrong.
  function probe(bytes) {
    const tmp = path.join(os.tmpdir(), "tl_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".mp4");
    try {
      fs.writeFileSync(tmp, bytes);
      const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp],
        { encoding: "utf8", timeout: 15000 });
      const frm = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", tmp], { encoding: "utf8", timeout: 15000 });
      const dim = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", tmp], { encoding: "utf8", timeout: 15000 });
      const duration = parseFloat((dur.stdout || "").trim()) || 0;
      const frames = parseInt((frm.stdout || "").trim(), 10) || 0;
      const [w, h] = (dim.stdout || "").trim().split(",").map((n) => parseInt(n, 10));
      const width = w > 0 ? w : 1920;
      const height = h > 0 ? h : 1080;
      return { duration, frames, width, height };
    } catch (e) {
      ctx.hublog("warn", "timelapse: ffprobe failed - " + (e && e.message || e));
      return { duration: 0, frames: 0, width: 1920, height: 1080 };
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  // Runs one ffmpeg step to completion, killing it if it runs past
  // timeoutMs - a stuck re-encode is not worth losing the video over, but
  // must not hang the Hub's event loop (also live-dispatching nine printers)
  // forever either. Rejects on a non-zero exit or a spawn error;
  // composeOrFallback/assembleVideo below are what turn that into a
  // fail-open outcome for their respective callers.
  function runFfmpeg(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = spawn("ffmpeg", args, { windowsHide: true }); }
      catch (e) { return reject(e); }
      const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      let stderr = "";
      if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (e) => { clearTimeout(killTimer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (code !== 0) reject(new Error("ffmpeg exited " + code + " - " + stderr.slice(-300)));
        else resolve();
      });
    });
  }

  // Assembles a job's captured frames into one silent .mp4 in pendingDir.
  // 2026-09-24 integration-test finding: ffmpeg can write a partial/empty
  // file to outPath before failing (a bad/truncated frame partway through
  // the sequence) - without the cleanup here, that orphaned file would sit
  // in pendingDir forever, never referenced by anything, never cleaned up.
  async function assembleVideo(state) {
    const safe = String(state.printer).replace(/[^A-Za-z0-9_-]/g, "_");
    const outPath = path.join(pendingDir, safe + "_" + state.startedAtMs + ".mp4");
    try {
      await runFfmpeg(assembleArgs(state.dir, outPath, CAPTURE_OUTPUT_FPS), COMPOSE_STEP_TIMEOUT_MS);
      const stat = fs.statSync(outPath);
      if (!stat || stat.size < 1000) throw new Error("assembled output looked empty/corrupt");
      return outPath;
    } catch (e) {
      try { fs.unlinkSync(outPath); } catch {} // don't leak a partial/empty file nothing will ever clean up
      throw e;
    }
  }

  // Builds intro(optional)+timelapse+outro as three separately-encoded clips
  // (all normalized to the same W x H / fps / pixel format via
  // scaleFitFilter) and stream-copies them together with the concat
  // demuxer - simpler and more robust than one filter_complex expression
  // mixing two image inputs and a video input that don't share native fps
  // or timestamps. The Hub's own captured clip carries no audio track
  // (it's assembled straight from JPEG frames), so the composited output is
  // silent throughout, deliberately, not by omission. Throws on any
  // failure; composeOrFallback below is what fails open.
  async function composeVideo(bytes, photoBytes, logoBytes, width, height) {
    const stamp = Date.now() + "_" + Math.random().toString(36).slice(2);
    const dir = os.tmpdir();
    const mainIn = path.join(dir, "tlc_main_" + stamp + ".mp4");
    const photoIn = path.join(dir, "tlc_photo_" + stamp + ".jpg");
    const logoIn = logoBytes ? path.join(dir, "tlc_logo_" + stamp + ".png") : null;
    const segMain = path.join(dir, "tlc_segmain_" + stamp + ".mp4");
    const segOutro = path.join(dir, "tlc_segoutro_" + stamp + ".mp4");
    const segIntro = logoBytes ? path.join(dir, "tlc_segintro_" + stamp + ".mp4") : null;
    const listFile = path.join(dir, "tlc_list_" + stamp + ".txt");
    const finalOut = path.join(dir, "tlc_final_" + stamp + ".mp4");
    const cleanup = () => {
      for (const p of [mainIn, photoIn, logoIn, segMain, segOutro, segIntro, listFile, finalOut]) {
        if (!p) continue;
        try { fs.unlinkSync(p); } catch {}
      }
    };
    try {
      fs.writeFileSync(mainIn, bytes);
      fs.writeFileSync(photoIn, photoBytes);
      if (logoIn) fs.writeFileSync(logoIn, logoBytes);

      await runFfmpeg(mainEncodeArgs(mainIn, segMain, width, height), COMPOSE_STEP_TIMEOUT_MS);

      const outro = stillEncodeArgs(photoIn, segOutro, width, height, PHOTO_HOLD_SEC, PHOTO_FADE_SEC, "in");
      await runFfmpeg(outro.args, COMPOSE_STEP_TIMEOUT_MS);

      const segments = [];
      if (segIntro) {
        const intro = stillEncodeArgs(logoIn, segIntro, width, height, LOGO_HOLD_SEC, LOGO_FADE_SEC, "both");
        await runFfmpeg(intro.args, COMPOSE_STEP_TIMEOUT_MS);
        segments.push(segIntro);
      }
      segments.push(segMain, segOutro);

      // Concat demuxer list format: each path quoted, an embedded single
      // quote escaped as '\'' - these are our own generated temp paths
      // under os.tmpdir(), never user input, but the escape costs nothing.
      const listBody = segments
        .map((p) => "file '" + p.replace(/\\/g, "/").replace(/'/g, "'\\''") + "'")
        .join("\n") + "\n";
      fs.writeFileSync(listFile, listBody);
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalOut],
        COMPOSE_STEP_TIMEOUT_MS);

      const out = fs.readFileSync(finalOut);
      if (!out || out.length < 1000) throw new Error("composed output looked empty/corrupt");
      cleanup();
      return out;
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  // Fails open to the plain timelapse bytes on ANY compositing problem
  // (missing ffmpeg, a bad photo fetch, a corrupt logo file, a timeout) -
  // exactly like the old CTA overlay failed open. No photo at all (product
  // not matched, publish_social off, no image on file) skips compositing
  // entirely rather than fading into a blank frame.
  async function composeOrFallback(bytes, photoBytes, logoBytes, width, height) {
    if (!photoBytes) return bytes;
    try {
      return await composeVideo(bytes, photoBytes, logoBytes, width, height);
    } catch (e) {
      ctx.hublog("warn", "timelapse: video compositing failed - posting the plain timelapse instead. " + (e && e.message || e));
      return bytes;
    }
  }

  // Looks up the finished-print photo for gcodeFilename via the same edge
  // function the upload POST already talks to - passcode in a header, not
  // the query string. Returns null (never throws past this point) on
  // anything short of a clean 200 with an image_url AND a real image body,
  // since "nothing to fade into" is this function's normal, expected answer
  // for most calls (no product match, publish_social off, no photo on
  // file), not an error worth logging every time.
  async function fetchEndPhoto(uploadUrl, passcode, gcodeFilename) {
    try {
      const u = new URL(uploadUrl);
      u.searchParams.set("gcode_filename", gcodeFilename);
      const r = await fetch(u.toString(), { headers: { "x-sf3d-passcode": passcode } });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      if (!j || !j.image_url) return null;
      const img = await fetch(j.image_url);
      if (!img.ok) return null;
      const buf = Buffer.from(await img.arrayBuffer());
      return buf.length > 500 ? buf : null;
    } catch (e) {
      ctx.hublog("warn", "timelapse: could not fetch end-of-video photo for " + gcodeFilename + " - " + (e && e.message || e));
      return null;
    }
  }

  // Reads config.json's timelapseUpload.logoFile off disk if it points at a
  // real file - a relative path resolves against the Hub's own baseDir,
  // same as every other config-driven path in this codebase. Missing
  // config, missing file, or a read error all mean the same thing: no logo
  // intro today, compose with the photo outro alone.
  function loadLogoBytes(c) {
    if (!c.logoFile) return null;
    const p = path.isAbsolute(c.logoFile) ? c.logoFile : path.join(ctx.baseDir, c.logoFile);
    try { return fs.readFileSync(p); } catch { return null; }
  }

  // Returns true when this job is DONE being tried (uploaded, or given up on
  // for a reason that will never change - no config, missing/corrupt file
  // on disk). Returns false to keep it queued for the next drain (a network
  // blip, a rejected upload) - see drain() below. The raw captured video
  // stays on disk at job.rawVideoPath until upload() either posts it or
  // gives up on it for good, so a false return never loses the source file.
  async function upload(job) {
    const c = uploadCfg();
    if (!uploadConfigured()) {
      // Queued by an older run, or the upload settings were removed since.
      try { fs.unlinkSync(job.rawVideoPath); } catch {}
      return true; // won't become true later without a config change anyway
    }
    const url = c.uploadUrl;

    let bytes;
    try { bytes = fs.readFileSync(job.rawVideoPath); }
    catch (e) {
      ctx.hublog("warn", "timelapse: captured video for " + job.printer + "/" + job.filename +
        " is missing on disk (" + (e && e.code || e.message) + ") - dropping, nothing left to retry");
      return true;
    }
    if (bytes.length < 1000) {
      ctx.hublog("warn", "timelapse: captured file for " + job.printer + "/" + job.filename +
        " is only " + bytes.length + " bytes - treating as corrupt, skipping");
      try { fs.unlinkSync(job.rawVideoPath); } catch {}
      return true;
    }

    const { duration, frames, width, height } = probe(bytes);
    if (duration < MIN_DURATION_SEC) {
      ctx.hublog("info", "timelapse: captured clip for " + job.printer + "/" + job.filename +
        " probed at " + duration + "s - shorter than the corruption guard, skipping");
      try { fs.unlinkSync(job.rawVideoPath); } catch {}
      return true;
    }

    // duration/frames come from the pre-compose probe deliberately - they
    // describe the Hub's own captured timelapse, matching what every other
    // row in the storefront's table already means; the intro/outro segments and
    // the re-encode change the posted file's own length, but re-probing the
    // composited output would silently redefine those two columns for just
    // the new rows.
    const photoBytes = await fetchEndPhoto(url, c.passcode, job.filename);
    const logoBytes = loadLogoBytes(c);
    const posted = await composeOrFallback(bytes, photoBytes, logoBytes, width, height);

    const printedAt = fmtPrintedAt(job.startAt || job.at);
    const form = new FormData();
    form.set("passcode", c.passcode);
    form.set("printer", job.printer);
    form.set("gcode_filename", job.filename);
    form.set("printed_at", printedAt);
    form.set("duration_seconds", String(duration));
    form.set("frame_count", String(frames));
    form.set("video", new Blob([posted], { type: "video/mp4" }), "timelapse.mp4");

    try {
      const res = await fetch(url, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        ctx.hublog("warn", "timelapse: upload rejected (" + res.status + ") for " + job.printer + "/" + job.filename + " - " + body.slice(0, 200));
        return false; // retry - could be a transient 5xx; rawVideoPath stays on disk
      }
      ctx.hublog("info", "timelapse: uploaded " + job.printer + "/" + job.filename +
        " (" + duration.toFixed(1) + "s, " + frames + " frames)");
      try { fs.unlinkSync(job.rawVideoPath); } catch {}
      return true;
    } catch (e) {
      ctx.hublog("warn", "timelapse: upload failed for " + job.printer + "/" + job.filename + " - " + e.message);
      return false; // retry - rawVideoPath stays on disk
    }
  }

  // ---- v2.40: where finished videos go ----------------------------------------
  // The upload block's name was sf3dTimelapse until 2.40; both are read.
  const uploadCfg = () => (ctx.cfg && (ctx.cfg.timelapseUpload || ctx.cfg.sf3dTimelapse)) || {};
  const tcfg = () => (ctx.cfg && typeof ctx.cfg.timelapse === "object" && ctx.cfg.timelapse) || {};
  const saveDirOf = () => { const d = String(tcfg().saveDir || "").trim(); return d ? path.resolve(ctx.baseDir, d) : null; };
  function uploadConfigured() {
    const c = uploadCfg();
    return !!(c.passcode && c.uploadUrl);
  }
  // Nowhere to put a video = nothing to capture (and no camera polling).
  function deliverable() { return !!saveDirOf() || uploadConfigured(); }
  const safeName = s => String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
  function stamp(ms) {
    const d = new Date(ms || Date.now()), z = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + " " + z(d.getHours()) + z(d.getMinutes());
  }
  const RECENT = [];   // last few saved videos, newest first, for the Settings card
  // Async only (the folder may be a network share). Never overwrites: a
  // name that exists gets " (2)", " (3)"... Failure is logged, not thrown.
  async function saveToFolder(printer, filename, startedAtMs, rawPath) {
    const dir = saveDirOf();
    if (!dir) return null;
    const base = safeName(printer) + " - " + safeName(String(filename || "").replace(/\.gcode$/i, "")) + " - " + stamp(startedAtMs);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      for (let n = 1; n < 100; n++) {
        const dest = path.join(dir, base + (n > 1 ? " (" + n + ")" : "") + ".mp4");
        try { await fs.promises.copyFile(rawPath, dest, fs.constants.COPYFILE_EXCL); }
        catch (e) { if (e.code === "EEXIST") continue; throw e; }
        RECENT.unshift({ file: path.basename(dest), printer, at: Date.now() }); RECENT.length = Math.min(RECENT.length, 8);
        ctx.hublog("info", "timelapse: saved " + dest);
        return dest;
      }
    } catch (e) {
      ctx.hublog("warn", "timelapse: could not save the video for " + printer + "/" + filename + " into " + dir + " - " + (e && e.message || e));
    }
    return null;
  }
  // ffmpeg is the one outside program this needs; the card says whether it is there.
  let FFMPEG = null;   // { ok, version } once checked
  function checkFfmpeg() {
    return new Promise(resolve => {
      require("child_process").execFile("ffmpeg", ["-version"], { windowsHide: true, timeout: 8000 }, (err, out) => {
        FFMPEG = err ? { ok: false, version: null } : { ok: true, version: (/ffmpeg version (\S+)/.exec(String(out)) || [])[1] || "found" };
        resolve(FFMPEG);
      });
    });
  }
  function view() {
    const dir = saveDirOf();
    return {
      saveDir: tcfg().saveDir || "", resolved: dir, ffmpeg: FFMPEG, upload_configured: uploadConfigured(),
      capturing: [...CAPTURE.values()].map(s => ({ printer: s.printer, file: s.filename, frames: s.frameIdx, since: s.startedAtMs })),
      recent: RECENT
    };
  }
  ctx.app.get("/api/timelapse", async (req, res) => {
    if (!FFMPEG || String(req.query.recheck || "") === "1") await checkFfmpeg();
    const v = view();
    v.folder_ok = v.resolved ? await fs.promises.stat(v.resolved).then(st => st.isDirectory(), () => false) : null;
    res.json(v);
  });
  // POST /api/timelapse/settings { saveDir } - blank turns saving off.
  ctx.app.post("/api/timelapse/settings", async (req, res) => {
    const d = String((req.body || {}).saveDir ?? "").trim();
    if (d.length > 400) return res.status(400).json({ error: "that path is too long" });
    ctx.cfg.timelapse = { ...tcfg(), saveDir: d };
    ctx.saveConfig();
    const v = view();
    if (v.resolved) {
      try { await fs.promises.mkdir(v.resolved, { recursive: true }); v.folder_ok = true; }
      catch (e) { v.folder_ok = false; v.folder_error = e.message; }
    } else v.folder_ok = null;
    ctx.hublog("info", "timelapse: save folder " + (d ? "set to " + v.resolved : "cleared"));
    res.json(v);
  });
  checkFfmpeg().catch(() => {});

  let RUNNING = false;
  async function drain() {
    if (RUNNING) return;
    RUNNING = true;
    try {
      const items = loadQueue();
      const remaining = [];
      for (const job of items) {
        let done;
        try { done = await upload(job); }
        catch (e) { ctx.hublog("error", "timelapse: unexpected error uploading " + job.printer + "/" + job.filename + " - " + (e && e.message || e)); done = false; }
        if (!done) remaining.push(job);
      }
      saveQueue(remaining);
    } finally { RUNNING = false; }
  }

  ctx.events.on("print.started", (ev) => { if (deliverable()) capStart(ev.printer, ev.filename); });
  ctx.events.on("print.cancelled", (ev) => {
    discardFrames(capStop(ev.printer));
    clearCaptureStateEntry(ev.printer);
  });
  ctx.events.on("print.error", (ev) => {
    discardFrames(capStop(ev.printer));
    clearCaptureStateEntry(ev.printer);
  });

  ctx.events.on("print.done", async (ev) => {
    const state = capStop(ev.printer);
    // Whatever happens next (assemble or discard), there is no ongoing
    // capture left to resume into - clear the resume point now rather than
    // leaving a stale entry a future restart might try to match against.
    clearCaptureStateEntry(ev.printer);
    if (!state) {
      ctx.hublog("info", "timelapse: " + ev.printer + " finished " + ev.filename + " but no capture was running for it - nothing to assemble");
      return;
    }
    if (state.frameIdx < MIN_CAPTURE_FRAMES) {
      ctx.hublog("info", "timelapse: only captured " + state.frameIdx + " frame(s) for " + ev.printer + "/" + ev.filename +
        " - too few to be worth a video, discarding");
      discardFrames(state);
      return;
    }
    let rawVideoPath;
    try {
      rawVideoPath = await assembleVideo(state);
    } catch (e) {
      ctx.hublog("warn", "timelapse: could not assemble captured frames for " + ev.printer + "/" + ev.filename + " - " + (e && e.message || e));
      discardFrames(state);
      return;
    }
    discardFrames(state); // frames are in the assembled video now - the source jpegs aren't needed again
    await saveToFolder(ev.printer, ev.filename, state.startedAtMs, rawVideoPath);
    if (!uploadConfigured()) { try { fs.unlinkSync(rawVideoPath); } catch {} return; }
    try {
      const items = loadQueue();
      items.push({ printer: ev.printer, filename: ev.filename, at: ev.at, startAt: state.startedAtMs, rawVideoPath });
      saveQueue(items);
    } catch (e) {
      ctx.hublog("error", "timelapse: could not queue " + ev.filename + " - " + (e && e.message || e));
      try { fs.unlinkSync(rawVideoPath); } catch {}
      return;
    }
    drain().catch((e) => ctx.hublog("error", "timelapse: drain failed - " + (e && e.message || e)));
  });

  // Boot catch-up: a Hub restart mid-print already missed that print's
  // "print.started" edge - no new event is coming for it. Give the fleet
  // poller (core/events.js) time to take its first snapshot, then either
  // RESUME a capture already in progress before the restart, or start a
  // fresh one for anything printing/paused that we have no record of.
  //
  // 2026-09-26: this used to always start fresh, on the theory that a short
  // timelapse beats none. That reasoning breaks down on a Hub that restarts
  // several times a day (this farm does, from unrelated feature work) - it
  // meant almost every video was just the tail end of its print, sometimes
  // so late the object already looked finished. See the CAPTURE_STATE
  // comment above for the real incident this came from.
  const bootCatchup = setTimeout(async () => {
    try {
      const fleet = await ctx.fleet();
      const printingNow = new Map(
        (fleet || [])
          .filter((p) => p && p.online && (p.state === "printing" || p.state === "paused") && p.filename)
          .map((p) => [p.name, p])
      );

      // Resolve every persisted entry first: resume it if the SAME file is
      // still printing on that printer, otherwise it's stale (the print
      // finished, was cancelled, or changed during the downtime) and its
      // orphaned directory is cleaned up now rather than waiting a day for
      // the age-based sweep above.
      //
      // Skip any printer this process is ALREADY capturing live - a normal
      // "print.started" earlier in this same run put it there, and it is
      // never stale just because this 6-second timer happens to fire after
      // it. Caught in testing: without this guard, boot catch-up could
      // delete the frame directory out from under its own in-progress
      // capture the very first time it ran, on every single boot.
      for (const [printerName, entry] of Object.entries(CAPTURE_STATE)) {
        if (CAPTURE.has(printerName)) continue;
        const p = printingNow.get(printerName);
        if (p && p.filename === entry.filename && entry.dir && fs.existsSync(entry.dir)) {
          printingNow.delete(printerName); // handled by the resume below
          capStart(printerName, entry.filename, entry);
        } else {
          if (entry.dir) { try { fs.rmSync(entry.dir, { recursive: true, force: true }); } catch {} }
          delete CAPTURE_STATE[printerName];
        }
      }
      saveCaptureState();

      // Anything still printing with no matching persisted entry (the
      // common case: a print that started and finished entirely between
      // restarts never touches this at all) starts a brand new capture.
      if (deliverable()) for (const p of printingNow.values()) {
        capStart(p.name, p.filename);
      }
    } catch (e) {
      ctx.hublog("warn", "timelapse: boot catch-up failed - " + (e && e.message || e));
    }
  }, 6000);
  if (bootCatchup.unref) bootCatchup.unref();

  // Replay anything left from a crash/restart mid-upload, and retry
  // periodically after that - a permanently-misconfigured passcode would
  // otherwise sit queued until the next unrelated print.done fires.
  const t0 = setTimeout(() => drain().catch(() => {}), 5000);
  if (t0.unref) t0.unref();
  const timer = setInterval(() => drain().catch(() => {}), 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  register, slugify, buildR2Key, fmtPrintedAt, scaleFitFilter, stillSegmentFilter,
  mainSegmentFilter, mainEncodeArgs, stillEncodeArgs, frameFileName, assembleArgs,
};
