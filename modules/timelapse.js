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

// 2026-09-23: Danny wants a burned-in CTA graphic on these videos ("order
// now in the TikTok Shop"). That's not accurate yet - there is no TikTok
// Shop today (SF3D just started registering as a seller, which is a manual
// process on tiktokshop.com only Danny can complete: business docs + a
// payout bank account). Shipping "Shop link in bio" now, which IS true
// today, matching the caption footer sf3d-timelapse-upload already appends.
// Flip this one string in config.json's sf3dTimelapse.ctaText once the Shop
// is approved and live - no code change needed for that switch.
const DEFAULT_CTA_TEXT = "Shop link in bio";
const CTA_TIMEOUT_MS = 120000; // a slow re-encode is not worth losing the video over, but must not hang forever

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

// ffmpeg's drawtext filter treats : \ ' and % as syntax inside its own
// option-value string (this is on top of, not instead of, normal argv
// handling - spawn() in burnCta below never goes through a shell, so no
// shell quoting is needed, only drawtext's own). ctaText is a short,
// Claude/Danny-controlled config string, not arbitrary user input, but
// escaping it properly costs nothing and a stray colon must not silently
// break the filtergraph.
function escapeDrawtext(text) {
  return String(text == null ? "" : text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "’") // a curly quote reads identically and sidesteps drawtext's own quoting rules entirely
    .replace(/%/g, "\\%");
}

// Bold system font, referenced by absolute path rather than a fontconfig
// family name lookup (font=Arial) - fontconfig family matching depends on a
// font cache that may or may not be warm on a given Windows box, while every
// Windows install ships this file at this path. Positioned at 80% of frame
// height so it clears TikTok's own username/caption overlay (bottom-left)
// and action-button rail (right edge) regardless of whether the source
// video is landscape or square - these camera renders are not shot in 9:16,
// which is a separate, larger question (crop/pad to vertical for better
// TikTok reach) worth raising with Danny separately; not addressed here.
const CTA_FONT_FILE = "C\\:/Windows/Fonts/arialbd.ttf";
function ctaFilter(text) {
  return "drawtext=fontfile='" + CTA_FONT_FILE + "':text='" + escapeDrawtext(text) +
    "':fontcolor=white:fontsize=h/16:box=1:boxcolor=black@0.55:boxborderw=16:" +
    "x=(w-text_w)/2:y=h*0.80";
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
  // wrong-but-present number beats losing the file outright.
  function probe(bytes) {
    const tmp = path.join(os.tmpdir(), "tl_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".mp4");
    try {
      fs.writeFileSync(tmp, bytes);
      const dur = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", tmp],
        { encoding: "utf8", timeout: 15000 });
      const frm = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", tmp], { encoding: "utf8", timeout: 15000 });
      const duration = parseFloat((dur.stdout || "").trim()) || 0;
      const frames = parseInt((frm.stdout || "").trim(), 10) || 0;
      return { duration, frames };
    } catch (e) {
      ctx.hublog("warn", "timelapse: ffprobe failed - " + (e && e.message || e));
      return { duration: 0, frames: 0 };
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  // Burns ctaText into the video and returns the new bytes. Fails open to
  // the ORIGINAL bytes on any problem (missing ffmpeg, missing font, a
  // corrupt render, a timeout) - a video without the graphic beats no video
  // at all, and this must never be the reason a real print's timelapse gets
  // dropped. Runs ffmpeg via spawn() (async), not spawnSync like probe()
  // above: probe() is a sub-second metadata read, but a real re-encode can
  // run tens of seconds, and this Hub is also live-dispatching nine
  // printers on the same event loop - spawnSync here would freeze all of
  // that for the duration.
  function burnCta(bytes, ctaText) {
    return new Promise((resolve) => {
      if (!ctaText || !String(ctaText).trim()) return resolve(bytes);

      const stamp = Date.now() + "_" + Math.random().toString(36).slice(2);
      const inPath = path.join(os.tmpdir(), "tlcta_in_" + stamp + ".mp4");
      const outPath = path.join(os.tmpdir(), "tlcta_out_" + stamp + ".mp4");
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { fs.unlinkSync(inPath); } catch {}
        try { fs.unlinkSync(outPath); } catch {}
        resolve(result);
      };

      try { fs.writeFileSync(inPath, bytes); }
      catch (e) { ctx.hublog("warn", "timelapse: could not stage temp file for CTA overlay - " + (e && e.message || e)); return finish(bytes); }

      const args = ["-y", "-i", inPath, "-vf", ctaFilter(ctaText),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "copy", outPath];
      let child;
      try { child = spawn("ffmpeg", args, { windowsHide: true }); }
      catch (e) { ctx.hublog("warn", "timelapse: could not start ffmpeg for CTA overlay - " + (e && e.message || e)); return finish(bytes); }

      const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, CTA_TIMEOUT_MS);
      let stderr = "";
      if (child.stderr) child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (e) => {
        clearTimeout(killTimer);
        ctx.hublog("warn", "timelapse: ffmpeg CTA overlay failed to start - " + (e && e.message || e));
        finish(bytes);
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (code !== 0) {
          ctx.hublog("warn", "timelapse: ffmpeg CTA overlay exited " + code + " - posting the un-overlaid video instead. " + stderr.slice(-300));
          return finish(bytes);
        }
        let out;
        try { out = fs.readFileSync(outPath); }
        catch (e) { ctx.hublog("warn", "timelapse: could not read ffmpeg CTA output - " + (e && e.message || e)); return finish(bytes); }
        if (!out || out.length < 1000) {
          ctx.hublog("warn", "timelapse: ffmpeg CTA output looked empty/corrupt - posting the un-overlaid video instead");
          return finish(bytes);
        }
        finish(out);
      });
    });
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

    const { duration, frames } = probe(bytes);
    if (duration < MIN_DURATION_SEC) {
      ctx.hublog("info", "timelapse: rendered clip for " + job.printer + "/" + job.filename +
        " probed at " + duration + "s - treating as a failed render, skipping");
      return true;
    }

    // duration/frames come from the pre-overlay probe deliberately - drawtext
    // draws over existing frames, it doesn't add/remove any, so re-probing
    // after the burn would just be the same numbers at the cost of another
    // ffprobe spawn.
    const posted = await burnCta(bytes, c.ctaText || DEFAULT_CTA_TEXT);

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

module.exports = { register, slugify, buildR2Key, fmtPrintedAt, pickCameraFile, escapeDrawtext, ctaFilter };
