// public/modules/advisor-ui.js — AI pre-flight (v2.25).
// Injected only when features.advisor is on. Two places, no tab:
//   * Settings: the "AI pre-flight" block — key, model, Test, and the plain
//     words about what is sent, to whom, and what it costs.
//   * The job card: a "✦ AI pre-flight" button beside Add to queue, a printer
//     picker, and the answer underneath. Nothing is sent until the button is
//     pressed; changing the selected file clears the panel.
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
  const money = v => v == null ? "" : (v < 0.01 ? "under a cent" : "$" + v.toFixed(2));

  let STATE = null;

  function style() {
    if (document.getElementById("advcss")) return;
    const s = document.createElement("style");
    s.id = "advcss";
    s.textContent = [
      ".advpanel{margin-top:10px; border:1px solid var(--line); border-radius:10px; padding:11px 13px; background:var(--panel-2,var(--panel)); font-size:13px; line-height:1.5;}",
      ".advpanel .advhead{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;}",
      ".advpanel .advverdict{font-family:var(--mono); font-weight:800; letter-spacing:.08em; font-size:11.5px; padding:2px 8px; border-radius:6px; border:1px solid var(--line);}",
      ".advpanel .advverdict.GO{color:var(--good,#46a758); border-color:color-mix(in srgb, var(--good,#46a758) 50%, var(--line));}",
      ".advpanel .advverdict.CHECK{color:var(--signal); border-color:color-mix(in srgb, var(--signal) 50%, var(--line));}",
      ".advpanel .advverdict.STOP{color:var(--bad,#e5484d); border-color:color-mix(in srgb, var(--bad,#e5484d) 50%, var(--line));}",
      ".advpanel .advbody p{margin:4px 0;}",
      ".advpanel .advbody ul{margin:4px 0 4px 18px; padding:0;}",
      ".advpanel .advbody li{margin:3px 0;}",
      ".advpanel .advfoot{margin-top:8px; font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); display:flex; gap:10px; flex-wrap:wrap; align-items:center;}",
      ".advpanel select.field{width:auto; flex:0 0 auto; font-size:12px; padding:4px 8px;}",
      ".advpanel .advstate{color:var(--ink-dim); font-size:12.5px;}",
      ".advpanel .advstate.err{color:var(--bad,#e5484d);}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- Settings block ------------------------------------------------------
  let SET = null;
  function buildSettings() {
    const host = document.getElementById("setModules");
    if (!host || SET) return;
    SET = document.createElement("div");
    SET.id = "setAdvisor";
    SET.innerHTML =
      '<label class="fl" style="margin-top:18px">AI pre-flight <span class="hint" id="advHint">off</span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">' +
      'Before you push a file, a <b>✦ AI pre-flight</b> button on the job card can have Claude read the slicer settings baked into the gcode and compare them with what is loaded in the printer you picked: wrong material or temperature for a head, an empty head a color needs, a missing prime tower, bed temperature wrong for the plate, cooling or speed that do not suit the filament. You get GO, CHECK or STOP and the reasons.<br><br>' +
      '<b>What it needs.</b> Your own Anthropic API key. Make one at <a href="https://platform.claude.com/" target="_blank" rel="noopener" style="color:var(--signal)">platform.claude.com</a> (sign in → API keys → Create key; it starts with <code>sk-ant-</code>), add a few dollars of credit there, and paste the key below. The key is saved in config.json on this computer, is never shown again, and is never sent anywhere but Anthropic.<br><br>' +
      '<b>What is sent, and when.</b> Only when you press the button. A text brief of a few thousand characters: the file name, the slicer settings Orca wrote into the gcode, the filaments it was sliced for, the object count, and what the Hub has recorded in that printer\'s heads. Never the gcode itself, never your printers\' addresses. <a href="#" id="advPreview" style="color:var(--signal)">Show the brief for the selected file</a>.<br><br>' +
      '<b>What it costs.</b> About a cent a review on Claude Sonnet 5, half that on Haiku. The same file against the same loadout is answered from a local cache for free.' +
      '</div>' +
      '<div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px">' +
      '<input class="field" id="advKey" type="password" placeholder="sk-ant-…" style="max-width:340px" autocomplete="off" spellcheck="false">' +
      '<select class="field" id="advModel" style="width:auto; flex:0 0 auto"></select>' +
      '<button class="btn ghost" id="advSave">Save</button>' +
      '<button class="btn ghost" id="advTest">Test key</button>' +
      '<button class="btn ghost" id="advClear" title="Forget the saved key">Remove key</button>' +
      '<span class="pstatus" id="advMsg"></span>' +
      '</div>';
    host.appendChild(SET);
    SET.querySelector("#advSave").addEventListener("click", saveSettings);
    SET.querySelector("#advTest").addEventListener("click", testKey);
    SET.querySelector("#advClear").addEventListener("click", async () => {
      const r = await jpost("/api/advisor/settings", { key: "" });
      if (r.ok) { paintSettings(r.d); saySet("ok", "Key removed."); refreshButton(); }
    });
    SET.querySelector("#advPreview").addEventListener("click", async e => {
      e.preventDefault();
      const file = window.SELECTED;
      if (!file) return saySet("err", "Select a file on the dashboard first, then come back here.");
      const type = (typeof window.activeType === "function" && window.activeType().slug) || "u1";
      const pid = pickPrinter();
      const r = await fetch("/api/advisor/brief?file=" + encodeURIComponent(file) + "&type=" + encodeURIComponent(type) + (pid != null ? "&printer=" + pid : ""));
      const t = r.ok ? await r.text() : "Could not build the brief.";
      const w = window.open("", "_blank");
      if (w) { w.document.write("<pre style='font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap;padding:16px'>" + esc(t) + "</pre>"); w.document.title = "AI pre-flight brief: " + file; }
    });
  }
  function saySet(cls, text) { const m = SET && SET.querySelector("#advMsg"); if (m) { m.className = "pstatus" + (cls ? " " + cls : ""); m.textContent = text || ""; } }
  function paintSettings(s) {
    if (!SET || !s) return;
    STATE = s;
    const sel = SET.querySelector("#advModel");
    sel.innerHTML = (s.models || []).map(m => '<option value="' + esc(m.id) + '"' + (m.id === s.model ? " selected" : "") + ">" + esc(m.label) + " · $" + m.in + "/$" + m.out + " per M tokens</option>").join("");
    if (!(s.models || []).some(m => m.id === s.model)) sel.insertAdjacentHTML("beforeend", '<option value="' + esc(s.model) + '" selected>' + esc(s.model) + "</option>");
    const key = SET.querySelector("#advKey");
    key.value = "";
    key.placeholder = s.key_set ? "key saved (…" + s.key_tail + "), paste a new one to replace" : "sk-ant-…";
    SET.querySelector("#advClear").style.display = s.key_set ? "" : "none";
    SET.querySelector("#advHint").textContent = s.key_set
      ? "on · " + s.reviews + " review" + (s.reviews === 1 ? "" : "s") + (s.spent_usd ? " · about $" + s.spent_usd.toFixed(2) + " spent" : "")
      : "off - no key";
  }
  async function saveSettings() {
    const b = { model: SET.querySelector("#advModel").value };
    const k = SET.querySelector("#advKey").value.trim();
    if (k) b.key = k;
    const r = await jpost("/api/advisor/settings", b);
    if (!r.ok) return saySet("err", r.d.error || "Could not save");
    paintSettings(r.d);
    saySet("ok", r.d.key_set ? "Saved. The ✦ AI pre-flight button is live on the job card." : "Saved. Add a key to turn it on.");
    refreshButton();
  }
  async function testKey() {
    const b = { model: SET.querySelector("#advModel").value };
    const k = SET.querySelector("#advKey").value.trim();
    if (k) b.key = k;
    saySet("", "Asking Anthropic…");
    const r = await jpost("/api/advisor/test", b);
    if (!r.ok) return saySet("err", r.d.error || "Test failed");
    saySet("ok", "Key works. " + (r.d.model || "") + " answered.");
  }

  // ---- Job card ---------------------------------------------------------------
  let BTN = null, PANEL = null, LASTFILE = null;
  function buildCard() {
    const qadd = document.getElementById("qadd");
    const card = document.getElementById("jobcard");
    if (!qadd || !card || BTN) return;
    style();
    BTN = document.createElement("button");
    BTN.className = "btn ghost";
    BTN.id = "advgo";
    BTN.style.cssText = "font-size:12px; padding:5px 11px";
    BTN.textContent = "✦ AI pre-flight";
    qadd.parentElement.appendChild(BTN);
    PANEL = document.createElement("div");
    PANEL.className = "advpanel";
    PANEL.id = "advpanel";
    PANEL.style.display = "none";
    const warn = document.getElementById("warn");
    if (warn && warn.parentElement === card) card.insertBefore(PANEL, warn.nextSibling); else card.appendChild(PANEL);
    BTN.addEventListener("click", () => openPanel());
    // The selected file's title is the one thing that always changes when a
    // new file is picked; watch it rather than patching the core's selectFile.
    const jt = document.getElementById("jt");
    if (jt) new MutationObserver(() => { if (window.SELECTED !== LASTFILE) { LASTFILE = window.SELECTED; PANEL.style.display = "none"; PANEL.innerHTML = ""; } }).observe(jt, { childList: true, characterData: true, subtree: true });
    refreshButton();
  }
  function refreshButton() {
    if (!BTN) return;
    const on = !!(STATE && STATE.key_set);
    BTN.title = on ? "Have Claude check this file's settings against the printer you pick" : "Add an Anthropic API key in Settings → AI pre-flight to turn this on";
    BTN.style.opacity = on ? "" : ".55";
  }
  function printers() {
    const slug = (typeof window.activeType === "function" && window.activeType().slug) || "u1";
    return (window.FLEET || []).filter(p => (p.ptype || "u1") === slug);
  }
  function pickPrinter() {
    const sel = PANEL && PANEL.querySelector("#advprinter");
    if (sel && sel.value !== "") return Number(sel.value);
    const ps = printers();
    const idle = ps.find(p => p.online && /standby|complete|cancelled|idle/i.test(p.state || "")) || ps.find(p => p.online) || ps[0];
    return idle ? idle.id : null;
  }
  function openPanel() {
    if (!window.SELECTED) return;
    if (!(STATE && STATE.key_set)) {
      PANEL.style.display = "";
      PANEL.innerHTML = '<div class="advstate">AI pre-flight needs your Anthropic API key. Open <b>Settings → AI pre-flight</b>, paste the key, press Save. Nothing is sent until you press this button again.</div>';
      return;
    }
    LASTFILE = window.SELECTED;
    const ps = printers();
    const def = pickPrinter();
    PANEL.style.display = "";
    PANEL.innerHTML =
      '<div class="advhead"><span class="advstate">Check <b>' + esc(window.SELECTED) + '</b> against</span>' +
      '<select class="field" id="advprinter">' + ps.map(p => '<option value="' + p.id + '"' + (p.id === def ? " selected" : "") + ">" + esc(p.name) + (p.online ? "" : " (offline)") + "</option>").join("") + "</select>" +
      '<button class="btn primary" id="advrun" style="font-size:12px; padding:5px 12px">Ask</button>' +
      '<span class="advstate" id="advstate"></span></div>' +
      '<div class="advbody" id="advbody"></div><div class="advfoot" id="advfoot"></div>';
    PANEL.querySelector("#advrun").addEventListener("click", () => run(false));
    run(false);
  }
  function renderText(text) {
    // First line is the verdict sentence; "- " or "• " lines become a list.
    const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let html = "", inList = false;
    for (const l of lines) {
      const li = /^(?:[-*•]|\d+[.)])\s+/.test(l);
      if (li && !inList) { html += "<ul>"; inList = true; }
      if (!li && inList) { html += "</ul>"; inList = false; }
      const body = esc(l.replace(/^(?:[-*•]|\d+[.)])\s+/, "")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
      html += li ? "<li>" + body + "</li>" : "<p>" + body + "</p>";
    }
    if (inList) html += "</ul>";
    return html;
  }
  async function run(force) {
    const st = PANEL.querySelector("#advstate"), body = PANEL.querySelector("#advbody"), foot = PANEL.querySelector("#advfoot");
    const pid = pickPrinter();
    if (pid == null) { st.className = "advstate err"; st.textContent = "No printer of this type to check against."; return; }
    const type = (typeof window.activeType === "function" && window.activeType().slug) || "u1";
    st.className = "advstate"; st.textContent = force ? "Asking again…" : "Asking Claude…";
    PANEL.querySelector("#advrun").disabled = true;
    const r = await jpost("/api/advisor/review", { file: window.SELECTED, type, printer: pid, mapping: window.MAPSEL || null, force: !!force });
    PANEL.querySelector("#advrun").disabled = false;
    if (!r.ok) { st.className = "advstate err"; st.textContent = r.d.error || "The review failed."; return; }
    st.textContent = "";
    const v = r.d.verdict;
    const first = String(r.d.text || "").split(/\r?\n/)[0] || "";
    const rest = String(r.d.text || "").split(/\r?\n/).slice(1).join("\n");
    body.innerHTML = (v ? '<div class="advhead"><span class="advverdict ' + v + '">' + v + '</span><span>' + esc(first.replace(/^\**\s*(GO|CHECK|STOP)\**\s*:?\s*/i, "")) + "</span></div>" : "") + renderText(v ? rest : r.d.text);
    const when = new Date(r.d.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    foot.innerHTML = esc(r.d.model || "") + (r.d.cost != null ? " · " + money(r.d.cost) : "") + " · " + (r.d.cached ? "from cache, " + when : when) +
      ' · <a href="#" id="advagain" style="color:var(--signal)">Ask again</a>' +
      ' · <span title="Claude cannot see the model geometry; it reads the settings and the loadout.">advice, not a guarantee</span>';
    foot.querySelector("#advagain").addEventListener("click", e => { e.preventDefault(); run(true); });
  }

  async function init() {
    if (window.HUB_FEATURES && window.HUB_FEATURES.advisor === false) return;
    buildSettings();
    buildCard();
    const s = await jget("/api/advisor");
    if (s) { paintSettings(s); STATE = s; refreshButton(); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
