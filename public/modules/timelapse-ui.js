// public/modules/timelapse-ui.js - the Timelapses block in Settings (v2.40).
// Injected only when features.timelapse is on. No tab: it appends one block
// to #setModules. One field (the folder finished videos are saved into),
// whether ffmpeg was found, what is being captured right now, and the last
// few videos saved.
"use strict";
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, d };
    } catch (e) { return { ok: false, d: { error: e.message } }; }
  }
  const ago = ms => {
    if (!ms) return "";
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (m < 90) return m + " min ago";
    const h = Math.round(m / 60); if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  };

  let ROOT = null;
  function build() {
    const host = document.getElementById("setModules");
    if (!host || ROOT) return;
    ROOT = document.createElement("div");
    ROOT.id = "setTimelapse";
    ROOT.innerHTML =
      '<label class="fl" style="margin-top:18px">Timelapses <span class="hint" id="tlHint"></span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">While a U1 prints, the Hub grabs a frame from its chamber camera every time a new layer starts, ' +
      'and when the print finishes it turns them into a short video and saves it here. Cancelled and failed prints are thrown away. ' +
      'Needs <a href="https://ffmpeg.org/download.html" target="_blank" rel="noopener" style="color:var(--signal)">ffmpeg</a> installed on the computer running the Hub. Leave the folder blank to stop capturing.</div>' +
      '<div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px">' +
      '<input class="field" id="tlDir" placeholder="folder for finished videos, e.g. C:\\Timelapses or /home/me/timelapses" style="max-width:420px" spellcheck="false">' +
      '<button class="btn ghost" id="tlSave">Save</button>' +
      '<span class="pstatus" id="tlMsg"></span>' +
      '</div>' +
      '<div class="hint" id="tlState" style="margin-top:8px; line-height:1.6"></div>';
    host.appendChild(ROOT);
    ROOT.querySelector("#tlSave").addEventListener("click", save);
    ROOT.querySelector("#tlDir").addEventListener("keydown", e => { if (e.key === "Enter") save(); });
  }
  function say(cls, text) {
    const m = ROOT && ROOT.querySelector("#tlMsg");
    if (m) { m.className = "pstatus" + (cls ? " " + cls : ""); m.textContent = text || ""; }
  }
  function paint(s) {
    if (!ROOT || !s) return;
    const dir = ROOT.querySelector("#tlDir");
    if (document.activeElement !== dir) dir.value = s.saveDir || "";
    const ff = s.ffmpeg;
    ROOT.querySelector("#tlHint").textContent = !s.saveDir && !s.upload_configured ? "off - no folder set"
      : (ff && !ff.ok) ? "ffmpeg not found" : "on";
    const lines = [];
    lines.push(ff ? (ff.ok ? "ffmpeg " + esc(ff.version) + " found." : '<span style="color:var(--bad,#e5484d)">ffmpeg was not found on this computer, so videos cannot be made. Install it and make sure the <code>ffmpeg</code> command works, then reload this page.</span>') : "Checking for ffmpeg...");
    if (s.resolved) lines.push("Saving to <code>" + esc(s.resolved) + "</code>" + (s.folder_ok === false ? ' - <span style="color:var(--bad,#e5484d)">that folder cannot be created or reached' + (s.folder_error ? " (" + esc(s.folder_error) + ")" : "") + "</span>" : "."));
    if (s.capturing && s.capturing.length) lines.push("Capturing now: " + s.capturing.map(c => esc(c.printer) + " (" + c.frames + " frame" + (c.frames === 1 ? "" : "s") + ")").join(", ") + ".");
    if (s.recent && s.recent.length) lines.push("Saved: " + s.recent.slice(0, 4).map(r => esc(r.file) + " <span style=\"opacity:.7\">" + ago(r.at) + "</span>").join(" · "));
    ROOT.querySelector("#tlState").innerHTML = lines.join("<br>");
  }
  async function save() {
    say("", "Saving...");
    const r = await jpost("/api/timelapse/settings", { saveDir: ROOT.querySelector("#tlDir").value });
    if (!r.ok) return say("err", r.d.error || "Could not save");
    paint(r.d);
    if (!r.d.saveDir) say("ok", "Saved. No folder set, so nothing will be captured.");
    else if (r.d.folder_ok === false) say("err", "Saved, but that folder cannot be created or reached.");
    else say("ok", "Saved. The next print that starts gets a timelapse.");
  }
  async function init() {
    if (window.HUB_FEATURES && window.HUB_FEATURES.timelapse === false) return;
    build();
    if (!ROOT) return;
    paint(await jget("/api/timelapse"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
