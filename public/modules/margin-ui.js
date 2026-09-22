// public/modules/margin-ui.js — "worth printing?" on the job card (v2.28).
// Injected only when features.margin is on. Two places, no tab:
//   * The job card: one line under the file's meta - what the plate costs in
//     filament, the least it has to sell for (per unit when the file name
//     carries the plate count, "x24"), and what that is per printer hour.
//   * Settings: the two rates, sell floor and filament cost per gram.
// The numbers come from /api/margin/quote; grams and the time estimate are
// the ones the core already loaded for the selected file (window.MAP).
"use strict";
(function () {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, d };
    } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; }
  }
  const usd = v => v == null ? "—" : "$" + (v < 1 ? v.toFixed(2) : v.toFixed(2).replace(/\.00$/, ""));
  const hrs = h => h == null ? "" : (h < 1 ? Math.round(h * 60) + " min" : (Math.round(h * 10) / 10) + " h");

  let RATES = null;

  function style() {
    if (document.getElementById("mgcss")) return;
    const s = document.createElement("style");
    s.id = "mgcss";
    s.textContent = [
      ".mgline{display:none; margin-top:6px; font-family:var(--mono); font-size:11px; line-height:1.6; color:var(--ink-dim);}",
      ".mgline.show{display:block;}",
      ".mgline b{color:var(--ink); font-weight:600;}",
      ".mgline .mgk{color:var(--ink-faint);}",
      ".mgline a{color:var(--ink-faint); text-decoration:none; margin-left:6px;}",
      ".mgline a:hover{color:var(--signal);}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- job card ---------------------------------------------------------------
  let LINE = null, LASTKEY = null;
  function buildCard() {
    const meta = document.getElementById("jmeta");
    if (!meta || LINE) return;
    style();
    LINE = document.createElement("div");
    LINE.className = "mgline";
    LINE.id = "mgline";
    meta.insertAdjacentElement("afterend", LINE);
    const jt = document.getElementById("jt");
    if (jt) new MutationObserver(() => refresh()).observe(jt, { childList: true, characterData: true, subtree: true });
    refresh();
  }
  async function refresh() {
    if (!LINE) return;
    const name = window.SELECTED, map = window.MAP;
    if (!name || !map) { LINE.className = "mgline"; return; }
    const am = map.amounts || {};
    const grams = am.total_g != null ? am.total_g : (am.slot_sum_g || null);
    const key = name + "|" + grams + "|" + (map.estTime || "");
    if (key === LASTKEY && LINE.className.includes("show")) return;
    LASTKEY = key;
    if (!grams) { LINE.className = "mgline"; return; }
    const q = await jget("/api/margin/quote?grams=" + encodeURIComponent(grams) + "&est=" + encodeURIComponent(map.estTime || "") + "&name=" + encodeURIComponent(name));
    if (!q || key !== LASTKEY) return;
    render(q);
  }
  function render(q) {
    if (q.cost == null) { LINE.className = "mgline"; return; }
    const parts = [];
    parts.push('<span class="mgk">filament</span> <b>' + usd(q.cost) + "</b>");
    if (q.qty) parts.push('<span class="mgk">sell for at least</span> <b>' + usd(q.min_unit) + "</b> each <span class=\"mgk\">(" + q.qty + " on the plate, " + usd(q.min_plate) + " total)</span>");
    else parts.push('<span class="mgk">sell the plate for at least</span> <b>' + usd(q.min_plate) + '</b> <span class="mgk" title="Put the count in the file name, like &quot;Penguin x20.gcode&quot;, to see the price per piece">(no x-count in the name)</span>');
    if (q.per_hour != null) parts.push("<b>" + usd(q.per_hour) + '</b> <span class="mgk">per printer hour over ' + hrs(q.hours) + "</span>");
    LINE.innerHTML = parts.join('<span class="mgk">  ·  </span>') +
      '<a href="#" id="mgcfg" title="At $' + q.sell_per_g.toFixed(2) + '/g sell floor and $' + q.cost_per_g.toFixed(2) + '/g filament - change in Settings">⚙</a>';
    LINE.className = "mgline show";
    const a = LINE.querySelector("#mgcfg");
    if (a) a.addEventListener("click", e => {
      e.preventDefault();
      const setup = document.getElementById("setup");   // the Settings panel (app.js opens it the same way for #settings)
      if (setup) setup.classList.add("show");
      const s = document.getElementById("setMargin");
      if (s) s.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  // ---- Settings block ---------------------------------------------------------
  let SET = null;
  function buildSettings() {
    const host = document.getElementById("setModules");
    if (!host || SET) return;
    SET = document.createElement("div");
    SET.id = "setMargin";
    SET.innerHTML =
      '<label class="fl" style="margin-top:18px">Worth printing? <span class="hint" id="mgHint"></span></label>' +
      '<div class="hint" style="margin-top:4px; max-width:640px">' +
      'Every selected file shows what its filament costs, the least it has to sell for (per piece when the file name carries the plate count, like <code>Penguin x20.gcode</code>), and what that comes to per printer hour. Two rates make the rule: the sell floor per gram and what filament costs you per gram. Nothing is decided from this; it is the number to look at before you queue a plate.' +
      '</div>' +
      '<div class="row" style="margin-top:8px; flex-wrap:wrap; gap:8px; align-items:center">' +
      '<span class="hint">sell floor $/g</span><input class="field" id="mgSell" type="number" step="0.01" min="0.01" style="max-width:110px">' +
      '<span class="hint">filament $/g</span><input class="field" id="mgCost" type="number" step="0.005" min="0" style="max-width:110px">' +
      '<button class="btn ghost" id="mgSave">Save</button>' +
      '<span class="pstatus" id="mgMsg"></span>' +
      '</div>';
    host.appendChild(SET);
    SET.querySelector("#mgSave").addEventListener("click", async () => {
      const r = await jpost("/api/margin/settings", { sell_per_g: SET.querySelector("#mgSell").value, cost_per_g: SET.querySelector("#mgCost").value });
      const m = SET.querySelector("#mgMsg");
      if (!r.ok) { m.className = "pstatus err"; m.textContent = r.d.error || "Could not save"; return; }
      paint(r.d); m.className = "pstatus ok"; m.textContent = "Saved."; LASTKEY = null; refresh();
    });
  }
  function paint(s) {
    if (!SET || !s) return;
    RATES = s;
    SET.querySelector("#mgSell").value = s.sell_per_g;
    SET.querySelector("#mgCost").value = s.cost_per_g;
    SET.querySelector("#mgHint").textContent = "$" + s.sell_per_g.toFixed(2) + "/g floor · $" + s.cost_per_g.toFixed(2) + "/g filament";
  }

  async function init() {
    if (window.HUB_FEATURES && window.HUB_FEATURES.margin === false) return;
    buildSettings();
    buildCard();
    const s = await jget("/api/margin");
    if (s) paint(s);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
