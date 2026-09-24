// modules/timelapse.js — SF3D timelapse pipeline, U1-camera edition (v2.27).
//
// Replaces the retired Raspberry Pi + Tapo-camera capture rig (ISP change
// killed it 2026-08-27; Danny does not want it back - poor mounting/framing
// on a C120). Archaeology (2026-09-21): the Pi's own capture/assemble/upload
// code never lived in this repo or SF3D's, in any commit - it only ever ran
// on the Pi's SD card, which is gone. This is a rebuild, not a repair.
//
// This module does NOT capture anything - no chamber-camera websocket, no
// frame grabbing, no local ffmpeg encode. Each U1 already renders its own
// finished timelapse in firmware (Snapmaker's own feature, not a Moonraker
// plugin - hardware-verified 2026-09-21 against two real prints on
// 192.168.12.175, both approved by Danny) and drops the .mp4 (+ a .jpg
// thumbnail) in that printer's own /server/files/camera/ folder. All this
// module does:
//   1. Listen for ctx.events "print.done" (core/events.js) - fires once per
//      real printing→complete edge, never replayed after a Hub restart.
//   2. Find the file the printer already rendered for that print.
//   3. Upload it to the SF3D edge function, which PUTs it to R2 and inserts
//      the sf3d_timelapses row using the same r2_key convention the 169
//      Pi-era videos already use.
//
// gcode_filename is Danny's explicit requirement (2026-09-21): it must match
// a product's sf3d_product_enrichment.gcode_files entries character for
// character, because sf3d-catalog joins on it verbatim. It comes straight off
// the print.done event - which core/events.js reads from the live fleet
// snapshot - and is never re-derived from the rendered video's own filename,
// which mangles spaces/parens unpredictably (see slugify below for exactly
// how much it mangles them).
//
// Fails open everywhere. No config, no camera-file match, a network hiccup,
// a rejected upload - each logs once and moves on, retrying on the next
// drain. A missed timelapse is a shrug; a module that can crash the Hub
// mid-print is not an acceptable trade for one.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

const CAMERA_LIST_RETRIES = 6;          // the printer needs a few seconds
const CAMERA_LIST_RETRY_MS = 5000;      // after "complete" to finish writing
                                         // the mp4 - poll for up to ~30s
const MATCH_WINDOW_MS = 5 * 60 * 1000;  // a render more than 5 min after the
                                         // print.done event isn't this print
const MIN_DURATION_SEC = 5;             // guards against a 0-byte/corrupt
                                         // render, NOT a "too short to care
                                         // about" cutoff - Snapmaker already
                                         // makes that call itself
const QUEUE_FILE = "timelapse-queue.json"; // survives a Hub restart mid-upload
const DEFAULT_UPLOAD_URL = "https://pcbltjgwnuyaixiealbk.supabase.co/functions/v1/sf3d-timelapse-upload";

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
// everything else in this module) - Danny hasn't supplied SF3D's brand
// logo file yet, so today every video composites with the photo outro only,
// and picks up the logo intro automatically the day a file lands there. No
// code change needed for that switch - same pattern the old ctaText flip was.
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

// Pick the newest camera-folder .mp4 that could plausibly be THIS print's
// render: modified no earlier than the print's own (approximate) start and
// no later than MATCH_WINDOW_MS after the print.done event fired. Several
// printers rendering the same popular file around the same time is normal
// (see the "Crystal Dragons" rows already in production) - the guard here is
// per-printer recency, not cross-checking the rendered filename against
// gcode_filename, since the rendered name mangles characters the DB's own
// convention doesn't (see slugify above).
function pickCameraFile(files, eventAtMs, startAtMs) {
  const lo = startAtMs || 0;
  const hi = eventAtMs + MATCH_WINDOW_MS;
  const candidates = (files || [])
    .filter((f) => f && /\.mp4$/i.test(String(f.path || "")))
    .filter((f) => {
      const mtimeMs = Number(f.modified) * 1000;
      return mtimeMs >= lo && mtimeMs <= hi;
    })
    .sort((a, b) => Number(b.modified) - Number(a.modified));
  return candidates[0] || null;
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

function register(ctx) {
  const queuePath = path.join(ctx.baseDir, QUEUE_FILE);

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

  async function listCameraFiles(base) {
    const r = await fetch(base + "/server/files/list?root=camera");
    if (!r.ok) return [];
    const j = await r.json().catch(() => null);
    return (j && j.result) || [];
  }

  async function fetchVideo(base, filePath) {
    const r = await fetch(base + "/server/files/camera/" + encodeURIComponent(filePath));
    if (!r.ok) throw new Error("printer returned " + r.status + " for " + filePath);
    return Buffer.from(await r.arrayBuffer());
  }

  // duration_seconds and frame_count are NOT NULL in sf3d_timelapses.
  // ffprobe is confirmed on ichabod's PATH (2026-09-21) but this still fails
  // open: a probe error returns zeros rather than dropping the video - a
  // wrong-but-present number beats losing the file outright. width/height
  // (added 2026-09-23) size the compositing canvas below; they default to
  // 1920x1080 - every U1 camera render checked so far - rather than 0x0,
  // since an all-zero scale target would make ffmpeg reject the filter
  // outright instead of just looking wrong.
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
  // composeOrFallback below is what turns that into a fail-open fallback.
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

  // Builds intro(optional)+timelapse+outro as three separately-encoded clips
  // (all normalized to the same W x H / fps / pixel format via
  // scaleFitFilter) and stream-copies them together with the concat
  // demuxer - simpler and more robust than one filter_complex expression
  // mixing two image inputs and a video input that don't share native fps
  // or timestamps. Every U1 camera render checked so far carries no audio
  // track (verified 2026-09-23 against a real timelapse), so the composited
  // output is silent throughout, deliberately, not by omission - worth
  // revisiting if that ever turns out not to hold for every printer.
  // Throws on any failure; composeOrFallback below is what fails open.
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
  // for a reason that will never change - no config, no match, corrupt
  // render). Returns false to keep it queued for the next drain (a network
  // blip, a rejected upload) - see drain() below.
  async function upload(job) {
    const c = (ctx.cfg && ctx.cfg.sf3dTimelapse) || {};
    if (!c.passcode) {
      ctx.hublog("warn", "timelapse: config.json has no sf3dTimelapse.passcode set - skipping upload for " +
        job.printer + "/" + job.filename + " (put the shop passcode there to enable uploads)");
      return true; // won't become true later without a restart anyway
    }
    const url = c.uploadUrl || DEFAULT_UPLOAD_URL;

    const printers = ctx.printers || [];
    const p = printers.find((x) => x.name === job.printer);
    if (!p) {
      ctx.hublog("warn", "timelapse: printer " + job.printer + " is no longer in config.json - dropping its queued upload for " + job.filename);
      return true;
    }
    const base = String(p.url).replace(/\/+$/, "");

    let match = null;
    for (let i = 0; i < CAMERA_LIST_RETRIES && !match; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, CAMERA_LIST_RETRY_MS));
      const files = await listCameraFiles(base).catch(() => []);
      match = pickCameraFile(files, job.at, job.startAt);
    }
    if (!match) {
      ctx.hublog("info", "timelapse: no rendered file appeared for " + job.printer + "/" + job.filename +
        " within " + Math.round(CAMERA_LIST_RETRIES * CAMERA_LIST_RETRY_MS / 1000) +
        "s - Snapmaker may have judged it too short to render, or the printer dropped off the LAN");
      return true;
    }

    let bytes;
    try { bytes = await fetchVideo(base, match.path); }
    catch (e) {
      ctx.hublog("warn", "timelapse: could not fetch " + match.path + " from " + job.printer + " - " + e.message);
      return false; // transient - retry on the next drain
    }
    if (bytes.length < 1000) {
      ctx.hublog("warn", "timelapse: rendered file for " + job.printer + "/" + job.filename +
        " is only " + bytes.length + " bytes - treating as a failed render, skipping");
      return true;
    }

    const { duration, frames, width, height } = probe(bytes);
    if (duration < MIN_DURATION_SEC) {
      ctx.hublog("info", "timelapse: rendered clip for " + job.printer + "/" + job.filename +
        " probed at " + duration + "s - treating as a failed render, skipping");
      return true;
    }

    // duration/frames come from the pre-compose probe deliberately - they
    // describe the ORIGINAL print's timelapse, matching what every other
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
        return false; // retry - could be a transient 5xx
      }
      ctx.hublog("info", "timelapse: uploaded " + job.printer + "/" + job.filename +
        " (" + duration.toFixed(1) + "s, " + frames + " frames)");
      return true;
    } catch (e) {
      ctx.hublog("warn", "timelapse: upload failed for " + job.printer + "/" + job.filename + " - " + e.message);
      return false;
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

  ctx.events.on("print.done", (ev) => {
    try {
      const items = loadQueue();
      items.push({ printer: ev.printer, filename: ev.filename, at: ev.at, startAt: ev.at - (ev.durationSec || 0) * 1000 });
      saveQueue(items);
    } catch (e) {
      ctx.hublog("error", "timelapse: could not queue " + (ev && ev.filename) + " - " + (e && e.message || e));
      return;
    }
    drain().catch((e) => ctx.hublog("error", "timelapse: drain failed - " + (e && e.message || e)));
  });

  // Replay anything left from a crash/restart mid-upload, and retry
  // periodically after that - a permanently-misconfigured passcode or a
  // printer removed from config would otherwise sit queued until the next
  // unrelated print.done fires.
  const t0 = setTimeout(() => drain().catch(() => {}), 5000);
  if (t0.unref) t0.unref();
  const timer = setInterval(() => drain().catch(() => {}), 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { register, slugify, buildR2Key, fmtPrintedAt, pickCameraFile, scaleFitFilter, stillSegmentFilter, mainSegmentFilter, mainEncodeArgs, stillEncodeArgs };
