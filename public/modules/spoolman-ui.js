// public/modules/spoolman-ui.js — the Spoolman import card on the Spools tab (v2.24).
// Injected only when features.spoolman is on. No tab, no HubModules
// registration: it is one card appended to the Spools view, after the bound
// spool list, because that is where the rolls it creates show up.
//
// One URL field, one Import button, one line of result. Nothing refreshes on
// its own: an import is a deliberate action with a visible count, never a
// background sync that quietly changes the shelf while you are looking at it.
"use strict";
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, d };
    } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; }
  }

  const ago = ms => {
    if (!ms) return "never";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return "just now";
    const m = Math.round(s / 60); if (m < 90) return m + " min ago";
    const h = Math.round(m / 60); if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  };

  function style() {
    if (document.getElementById("smcss")) return;
    const s = document.createElement("style");
    s.id = "smcss";
    s.textContent = [
      ".smrow{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px;}",
      ".smrow input{flex:1 1 220px; min-width:0; font:inherit; font-size:13px; background:var(--bg,#14161b);",
      "  color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px 10px;}",
      ".smrow .gear{font-size:12px; padding:7px 12px;}",
      ".smstate{font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); min-height:16px; margin-top:8px; white-space:pre-wrap;}",
      ".smstate.err{color:var(--bad,#e5484d);}",
      ".smstate.ok{color:var(--good,#46a758);}",
      ".smnote{font-size:12px; color:var(--ink-faint); margin-top:6px; line-height:1.45;}"
    ].join("\n");
    document.head.appendChild(s);
  }

  let CARD = null;

  function build(state) {
    const wrap = document.querySelector("#spoolview .spoolwrap");
    if (!wrap || CARD) return;
    style();
    CARD = document.createElement("div");
    CARD.className = "spoolcard";
    CARD.id = "smcard";
    CARD.innerHTML =
      '<div class="fshead">Spoolman</div>' +
      '<div class="smnote">Already keep your rolls in <a href="https://github.com/Donkie/Spoolman" target="_blank" rel="noopener">Spoolman</a>? ' +
      'Pull them in here instead of typing them twice. One way only: the Hub reads Spoolman and never writes to it. ' +
      'Import again any time to pick up new rolls and updated weights; a roll archived in Spoolman goes inactive here.</div>' +
      '<div class="smrow">' +
      '<input id="smurl" type="url" placeholder="http://spoolman.local:7912" autocomplete="off" spellcheck="false">' +
      '<button class="gear" id="smtest">Test</button>' +
      '<button class="gear" id="smimport">Import</button>' +
      '</div>' +
      '<div class="smstate" id="smstate"></div>';
    const attrib = wrap.querySelector(".attrib");
    if (attrib) wrap.insertBefore(CARD, attrib); else wrap.appendChild(CARD);
    CARD.querySelector("#smtest").addEventListener("click", test);
    CARD.querySelector("#smimport").addEventListener("click", doImport);
    CARD.querySelector("#smurl").addEventListener("change", saveUrl);
    paint(state);
  }

  function paint(state) {
    if (!CARD || !state) return;
    const url = CARD.querySelector("#smurl");
    if (document.activeElement !== url) url.value = state.url || "";
    const st = CARD.querySelector("#smstate");
    const L = state.last;
    let msg = "";
    if (!state.available) msg = "The Spools module is off, so there is nowhere to put imported rolls.";
    else if (L && L.ok) msg = "Last import " + ago(L.at) + ": " + L.imported + " roll" + (L.imported === 1 ? "" : "s") +
      " (" + L.created + " new, " + L.updated + " updated" + (L.retired ? ", " + L.retired + " inactive" : "") + (L.skipped ? ", " + L.skipped + " skipped" : "") + ")";
    else if (L && !L.ok) msg = "Last import " + ago(L.at) + " failed: " + L.error;
    else if (state.imported_count) msg = state.imported_count + " rolls here came from Spoolman.";
    st.className = "smstate" + (L && !L.ok ? " err" : "");
    st.textContent = msg;
    CARD.querySelector("#smimport").disabled = !state.configured || !state.available;
  }

  function say(cls, text) {
    const st = CARD && CARD.querySelector("#smstate");
    if (!st) return;
    st.className = "smstate" + (cls ? " " + cls : "");
    st.textContent = text;
  }

  async function saveUrl() {
    const v = CARD.querySelector("#smurl").value.trim();
    const r = await jpost("/api/spoolman/settings", { url: v });
    if (!r.ok) return say("err", r.d.error || "Could not save the URL");
    paint(r.d);
    if (v) say("", "Saved. Press Test to check the connection, or Import to pull the rolls.");
  }

  async function test() {
    const v = CARD.querySelector("#smurl").value.trim();
    if (!v) return say("err", "Enter the Spoolman address first, e.g. http://192.168.1.50:7912");
    say("", "Checking " + v + " …");
    const r = await jpost("/api/spoolman/test", { url: v });
    if (!r.ok) return say("err", r.d.error || "Spoolman did not answer");
    say("ok", "Spoolman " + (r.d.version || "") + " answered at " + r.d.url);
  }

  async function doImport() {
    const b = CARD.querySelector("#smimport");
    b.disabled = true;
    say("", "Importing …");
    const r = await jpost("/api/spoolman/import", {});
    b.disabled = false;
    if (!r.ok) { paint(r.d); return say("err", r.d.error || "Import failed"); }
    paint(r.d);
    const sk = (r.d.skipped || []);
    let line = "Imported " + r.d.imported + " roll" + (r.d.imported === 1 ? "" : "s") + ": " + r.d.created + " new, " + r.d.updated + " updated";
    if (r.d.retired) line += ", " + r.d.retired + " now inactive";
    if (sk.length) line += "\nSkipped " + sk.length + " (no color in Spoolman): #" + sk.slice(0, 12).map(x => x.id).join(", #") + (sk.length > 12 ? " …" : "");
    say("ok", line);
    if (typeof window.loadSpools === "function") window.loadSpools().catch(() => {});
  }

  async function init() {
    if (window.HUB_FEATURES && (window.HUB_FEATURES.spoolman === false || window.HUB_FEATURES.spools === false)) return;
    const state = await jget("/api/spoolman");
    if (!state) return;
    build(state);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
