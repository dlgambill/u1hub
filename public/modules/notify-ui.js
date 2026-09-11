// public/modules/notify-ui.js — the ntfy notifications block in Settings (v2.24).
// Injected only when features.notify is on. No tab: it appends one block to
// #setModules inside the Settings panel. Server, topic, optional token, which
// events, a Test button, and the plain truth about what was last sent.
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
    if (!ms) return "never";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return "just now";
    const m = Math.round(s / 60); if (m < 90) return m + " min ago";
    const h = Math.round(m / 60); if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  };

  const EVENTS = [
    ["done", "Print finished"], ["paused", "Paused (with the firmware's reason)"], ["error", "Error"],
    ["offline", "Printer unreachable"], ["online", "Printer back online"], ["started", "Print started"], ["cancelled", "Print cancelled"]
  ];

  let ROOT = null, STATE = null;

  function build() {
    const host = document.getElementById("setModules");
    if (!host || ROOT) return;
    ROOT = document.createElement("div");
    ROOT.id = "setNotify";
    ROOT.innerHTML =
      '<label class="fl" style="margin-top:18px">Phone notifications <span class="hint" id="ntHint">via ntfy</span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">Install the free <a href="https://ntfy.sh" target="_blank" rel="noopener" style="color:var(--signal)">ntfy</a> app, ' +
      'subscribe it to a topic name of your choosing, and enter the same topic here. The Hub posts to it when a print finishes, a printer pauses (with the reason), errors, or stops answering. ' +
      'Pick a topic nobody would guess: on the public ntfy.sh server, anyone who knows it can read it. Nothing else about your Hub leaves the building.</div>' +
      '<div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px">' +
      '<input class="field" id="ntUrl" placeholder="https://ntfy.sh" style="max-width:220px">' +
      '<input class="field" id="ntTopic" placeholder="topic, e.g. dannys-print-farm-7f3a" style="max-width:260px" autocomplete="off" spellcheck="false">' +
      '<input class="field" id="ntToken" type="password" placeholder="access token (only for protected topics)" style="max-width:260px" autocomplete="off">' +
      '</div>' +
      '<div class="row" id="ntEvents" style="margin-top:8px; flex-wrap:wrap; gap:6px 14px"></div>' +
      '<div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap">' +
      '<label class="hint" style="display:flex; align-items:center; gap:6px; cursor:pointer"><input type="checkbox" id="ntOn"> Send notifications</label>' +
      '<button class="btn ghost" id="ntSave">Save</button>' +
      '<button class="btn ghost" id="ntTest">Send a test</button>' +
      '<span class="pstatus" id="ntMsg"></span>' +
      '</div>';
    host.appendChild(ROOT);
    const ev = ROOT.querySelector("#ntEvents");
    ev.innerHTML = EVENTS.map(([k, label]) =>
      '<label class="hint" style="display:flex; align-items:center; gap:5px; cursor:pointer"><input type="checkbox" data-ev="' + k + '"> ' + esc(label) + '</label>').join("");
    ROOT.querySelector("#ntSave").addEventListener("click", save);
    ROOT.querySelector("#ntTest").addEventListener("click", test);
  }

  function say(cls, text) {
    const m = ROOT && ROOT.querySelector("#ntMsg");
    if (!m) return;
    m.className = "pstatus" + (cls ? " " + cls : "");
    m.textContent = text || "";
  }

  function paint(s) {
    if (!ROOT || !s) return;
    STATE = s;
    const q = sel => ROOT.querySelector(sel);
    if (document.activeElement !== q("#ntUrl")) q("#ntUrl").value = s.url || "";
    if (document.activeElement !== q("#ntTopic")) q("#ntTopic").value = s.topic || "";
    q("#ntToken").placeholder = s.token_set ? "token saved (leave blank to keep)" : "access token (only for protected topics)";
    q("#ntOn").checked = !!s.enabled;
    for (const cb of ROOT.querySelectorAll("[data-ev]")) cb.checked = !!(s.events && s.events[cb.dataset.ev]);
    const st = s.stats || {};
    const hint = q("#ntHint");
    if (!s.enabled) hint.textContent = "off";
    else if (!s.topic) hint.textContent = "on, but no topic set";
    else hint.textContent = "on · " + (st.sent || 0) + " sent" + (st.last_sent ? ", last " + ago(st.last_sent) : "") + (st.last_error ? " · last failure: " + st.last_error : "");
  }

  function form() {
    const q = sel => ROOT.querySelector(sel);
    const events = {};
    for (const cb of ROOT.querySelectorAll("[data-ev]")) events[cb.dataset.ev] = cb.checked;
    const b = { url: q("#ntUrl").value.trim(), topic: q("#ntTopic").value.trim(), events, enabled: q("#ntOn").checked };
    const tok = q("#ntToken").value;
    if (tok) b.token = tok;
    return b;
  }

  async function save() {
    const r = await jpost("/api/notify/settings", form());
    if (!r.ok) return say("err", r.d.error || "Could not save");
    ROOT.querySelector("#ntToken").value = "";
    paint(r.d);
    say("ok", r.d.enabled ? "Saved. Notifications are on." : "Saved. Notifications are off.");
  }

  async function test() {
    const f = form();
    if (!f.topic) return say("err", "Enter a topic first");
    say("", "Sending…");
    const body = { url: f.url, topic: f.topic };
    if (f.token) body.token = f.token;
    const r = await jpost("/api/notify/test", body);
    if (!r.ok) return say("err", r.d.error || "ntfy did not accept it");
    say("ok", "Sent. Check the ntfy app on your phone.");
    paint(r.d);
  }

  async function init() {
    if (window.HUB_FEATURES && window.HUB_FEATURES.notify === false) return;
    build();
    if (!ROOT) return;
    paint(await jget("/api/notify"));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
