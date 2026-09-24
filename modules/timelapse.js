// modules/timelapse.js — SF3D timelapse pipeline, U1-camera edition (v2.34).
//
// 2026-09-24 rewrite. The 2.27-2.33 version of this module assumed every U1
// renders its own finished timelapse in firmware and all the Hub had to do
// was fetch the file: "Each U1 already renders its own finished timelapse
// in firmware (Snapmaker's own feature, not a Moonraker plugin -
// hardware-verified 2026-09-21 against two real prints on 192.168.12.175,
// both approved by Danny)". That verification was real but narrower than the
// comment implied - it confirmed firmware rendering had worked, in the past,
// on one printer. It was never re-checked against a fresh completion, and
// nobody ever checked the other eight printers at all.
//
// Danny, after this went live and produced nothing for days:
//   "WTF? We just set this up the other day to build timelapse's from the
//   printer's cameras and upload them to R2. Why isn't it working?"
// A fleet-wide check that day found: only U1 and U2 have EVER had a rendered
// file in their camera folder, and the newest of those is from January
// 2026 - months before this module existed. U3-U9 have never had one. The
// "wait for firmware, then fetch" design was fetching from an oven that
// wasn't on.
//
// What Danny actually asked for - and what TIMELAPSE-PLAN.md (in this repo,
// written 2026-09-19, apparently never implemented) already called
// "Option A" - is for the HUB to do the capturing: watch a print's layer
// count and grab a frame from the chamber camera every time it advances,
// then assemble the frames into a video itself once the print finishes.
// That's what this version does:
//   1. "print.started" (core/events.js) opens the printer's chamber-camera
//      socket (same camera.start_monitor plugin modules/camera.js already
//      uses for live view - see there for the protocol notes) and polls
//      /printer/objects/query?print_stats every CAPTURE_POLL_MS. Each time
//      current_layer advances, grab one frame from monitor.jpg and save it.
//   2. "print.done" stops the poll, and - if enough frames came in - runs
//      ffmpeg once to turn frame_000001.jpg, frame_000002.jpg, ... into a
//      silent .mp4 at CAPTURE_OUTPUT_FPS.
//   3. That raw video is queued (surviving a Hub restart, same as before)
//      and handed to the SAME compose/upload pipeline 2.32-2.33 already
//      built: logo intro, product-photo outro, POST to the SF3D edge
//      function, which PUTs to R2 and inserts the sf3d_timelapses row.
// "print.cancelled" / "print.error" stop the capture and throw the frames
// away - an abandoned print isn't worth a timelapse of. A Hub restart
// mid-print picks capture back up (fewer frames than a full print, but a
// short timelapse beats none) - see the boot catch-up below.
//
// gcode_filename is still Danny's explicit requirement (2026-09-21): it must
// match a product's sf3d_product_enrichment.gcode_files entries character
// for character, because sf3d-catalog joins on it verbatim. It still comes
// straight off the fleet event, never derived from a filename on disk.
//
// Fails open everywhere. No config, no camera reachable, a network hiccup,
// a rejected upload - each logs once and moves on. A missed timelapse is a
// shrug; a module that can crash the Hub mid-print, or that stalls an
// actual print job waiting on a frame grab, is not an acceptable trade for
// one. Capture runs on its own timer against the printer's own reported
// layer count - it never pauses or steps a print to get a frame (that's
// TIMELAPS-PLAN.md's "Option B", explicitly deferred, not built here).
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
const DEFAULT_UPLOAD_URL = "https://pcbltjgwnuyaixiealbk.supabase.co/functions/v1/sf3d-timelapse-upload";

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
const FRAME_GLOB = "frame_%06d.jpg";
const ORPHAN_FRAMES_MAX_AGE_MS = 24 * 60 * 60 * 1000; // a frame dir left over
                                         // from a crash is never going to
                                         // finish on its own - clean it up
                                         // instead of leaking disk forever

// 2026-09-23: Danny rejected the burned-in "Shop link in bio" text overlay
// shipped earlier today ("Get rid of it. I don't like it.") - real Shop
// tagging is TikTok's own native product card, which only comes from the
// manual in-app "Add Link" step once his TikTok Shop is live; there is no
// API field for it, so nothing here fakes it with text. In its place: the
// video fades from SF3D's logo into the timelapse, then fades out to a
// still photo of the finished print - both per that same message.
//
// The photo is looked up from sf3d-timelapse-upload's GET route by
// gcode_filename (no Square credentials on this Hub); the logo is read
// straight off disk if config.json's sf3dTimelapse.logoFile points at a
// real file, and skipped entirely if it doesn't (fails open, same as
// everything else in this module).
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

// Reverse-engineered 2026-09-21 from all 169 existing sf3d_timelapses rows
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
// on the real timelapse it visibly scrambled frames (Danny: looked like "a
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
    if (!frame) return;
    const idx = state.frameIdx + 1;
    try {
      fs.writeFileSync(path.join(state.dir, frameFileName(idx)), frame);
      state.frameIdx = idx;
    } catch (e) {
      ctx.hublog("warn", "timelapse: could not save a captured frame for " + state.printer + " - " + (e && e.message || e));
    }
  }

  // Idempotent: a duplicate "print.started" for a printer already being
  // captured (shouldn't happen - core/events.js only emits it on a real
  // non-printing -> printing edge - but costs nothing to guard) is ignored
  // rather than starting a second, competing capture into a new directory.
  function capStart(printerName, filename) {
    if (CAPTURE.has(printerName)) return;
    const p = findPrinter(printerName);
    if (!p) {
      ctx.hublog("warn", "timelapse: can't start capture for " + printerName + " - it isn't in config.json");
      return;
    }
    const base = String(p.url).replace(/\/+$/, "");
    const safe = String(printerName).replace(/[^A-Za-z0-9_-]/g, "_");
    const dir = path.join(framesRoot, safe + "_" + Date.now());
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) {
      ctx.hublog("error", "timelapse: could not create a frame directory for " + printerName + " - " + (e && e.message || e));
      return;
    }
    const state = {
      printer: printerName, filename, base, dir,
      frameIdx: 0, lastLayer: undefined, startedAtMs: Date.now(),
      ws: null, active: true, pollTimer: null,
    };
    CAPTURE.set(printerName, state);
    capOpenSocket(state);
    state.pollTimer = setInterval(() => {
      capPollOnce(state).catch((e) => ctx.hublog("warn", "timelapse: capture poll failed for " + printerName + " - " + (e && e.message || e)));
    }, CAPTURE_POLL_MS);
    if (state.pollTimer.unref) state.pollTimer.unref();
    ctx.hublog("info", "timelapse: capture started for " + printerName + "/" + filename);
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

  // duration_seconds and frame_count are NOT NULL in sf3d_timelapses.
  // ffprobe is confirmed on ichabod's PATH (2026-09-21) but this still fails
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

  // Reads config.json's sf3dTimelapse.logoFile off disk if it points at a
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
    const c = (ctx.cfg && ctx.cfg.sf3dTimelapse) || {};
    if (!c.passcode) {
      ctx.hublog("warn", "timelapse: config.json has no sf3dTimelapse.passcode set - skipping upload for " +
        job.printer + "/" + job.filename + " (put the shop passcode there to enable uploads)");
      try { fs.unlinkSync(job.rawVideoPath); } catch {}
      return true; // won't become true later without a restart anyway
    }
    const url = c.uploadUrl || DEFAULT_UPLOAD_URL;

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
    // row in sf3d_timelapses already means; the intro/outro segments and
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

  ctx.events.on("print.started", (ev) => { capStart(ev.printer, ev.filename); });
  ctx.events.on("print.cancelled", (ev) => discardFrames(capStop(ev.printer)));
  ctx.events.on("print.error", (ev) => discardFrames(capStop(ev.printer)));

  ctx.events.on("print.done", async (ev) => {
    const state = capStop(ev.printer);
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
  // poller (core/events.js) time to take its first snapshot, then start
  // capture for anything already printing/paused. Starting mid-print means
  // fewer frames than a full capture, but a short timelapse beats none.
  const bootCatchup = setTimeout(async () => {
    try {
      const fleet = await ctx.fleet();
      for (const p of fleet || []) {
        if (p && p.online && (p.state === "printing" || p.state === "paused") && p.filename) {
          capStart(p.name, p.filename);
        }
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
