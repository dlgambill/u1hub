// public/modules/margin-ui.js — "worth printing?" on the job card (v2.28),
// and what it actually sells for (v2.29).
// Injected only when features.margin is on. Two places, no tab:
//   * The job card: one line under the file's meta - what the plate costs in
//     filament, the least it has to sell for (per unit when the file name
//     carries the plate count, "x24"), and what that is per printer hour.
//     Beside it (v2.29) a box for what a piece really sells for: type a price
//     and the line answers with dollars per printer hour, dollars per gram and
//     the margin over filament, live; Save keeps a row per file, and "table"
//     opens every saved file sorted by those numbers.
//   * Settings: the two rates, sell floor and filament cost per gram.
// The floor numbers come from /api/margin/quote; grams and the time estimate
// are the ones the core already loaded for the selected file (window.MAP).
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
  const r2 = v => Math.round(v * 100) / 100;
  const typeSlug = () => (typeof window.activeType === "function" && window.activeType().slug) || "u1";

  let RATES = null;

  function style() {
    if (document.getElementById("mgcss")) return;
    const s = document.createElement("style");
    s.id = "mgcss";
    s.textContent = [
      ".mgline{display:none; margin-top:6px; font-family:var(--mono); font-size:11.5px; line-height:1.7; color:var(--ink-dim);}",
      ".mgline.show{display:block;}",
      ".mgline b{color:var(--ink); font-weight:600;}",
      ".mgline .mgk{color:var(--ink-faint);}",
      ".mgline a{color:var(--ink-faint); text-decoration:none; margin-left:6px;}",
      ".mgline a:hover{color:var(--signal);}",
      // v2.29: the price row. Same mono voice as the line above it; the input
      // is the one sans element, because a number you type is not a readout.
      ".mgprice{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:2px;}",
      ".mgprice input{font:inherit; font-family:var(--sans); font-size:13px; width:76px; color:var(--ink); background:var(--panel-2); border:1px solid var(--line); border-radius:var(--r-sm,6px); padding:3px 7px;}",
      ".mgprice input:focus{outline:none; border-color:color-mix(in srgb, var(--signal) 55%, var(--line)); box-shadow:0 0 0 3px color-mix(in srgb, var(--signal) 16%, transparent);}",
      ".mgprice .btn{font-size:11.5px; padding:3px 10px;}",
      // 2.30.2: never nowrap here. .main is a grid item (min-width:auto), so an
      // unbreakable 80-character readout made the whole column wider than a
      // phone and the shell's overflow-x:clip cut every card off at the edge.
      ".mgprice .mgres{white-space:normal; overflow-wrap:anywhere;}",
      ".mgprice .mgres.low b{color:var(--bad,#e5484d);}",
      ".mgprice .mgres.ok b{color:var(--ok,#3DD68C);}",
      ".mgprice .mgsaved{color:var(--ink-faint);}",
      // the table
      ".mgtable{width:100%; border-collapse:collapse; font-size:12.5px;}",
      ".mgtable th{text-align:right; font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); padding:6px 8px; border-bottom:1px solid var(--line); cursor:pointer; white-space:nowrap; user-select:none;}",
      ".mgtable th:first-child{text-align:left;}",
      ".mgtable th.on{color:var(--signal);}",
      ".mgtable td{padding:6px 8px; border-bottom:1px solid var(--line-soft); text-align:right; font-family:var(--mono); font-size:11.5px; color:var(--ink-dim); white-space:nowrap; font-variant-numeric:tabular-nums;}",
      ".mgtable td:first-child{text-align:left; font-family:var(--sans); font-size:13px; color:var(--ink); white-space:normal; min-width:160px;}",
      ".mgtable td.hi{color:var(--ink); font-weight:600;}",
      ".mgtable tr.low td:first-child::after{content:' · below floor'; font-family:var(--mono); font-size:10.5px; color:var(--bad,#e5484d);}",
      ".mgtable td .mgrm{background:transparent; border:none; color:var(--ink-faint); cursor:pointer; font:inherit; padding:0 4px;}",
      ".mgtable td .mgrm:hover{color:var(--bad,#e5484d);}",
      ".mgtable tfoot td{border-bottom:none; color:var(--ink-faint); padding-top:10px;}",
      ".mgwrap{overflow:auto; max-height:60vh;}",
      ".mgnote{font-size:12px; color:var(--ink-faint); margin-top:10px; line-height:1.5;}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // ---- job card ---------------------------------------------------------------
  let LINE = null, LASTKEY = null, QUOTE = null, SAVED = null;
  function buildCard() {
    const meta = document.getElementById("jmeta");
    if (!meta || LINE) return;
    style();
    LINE = document.createElement("div");
    LINE.className = "mgline";
    LINE.id = "mgline";
    meta.insertAdjacentElement("afterend", LINE);
    LINE.addEventListener("input", e => { if (e.target.id === "mgin") preview(); });
    LINE.addEventListener("keydown", e => { if (e.target.id === "mgin" && e.key === "Enter") { e.preventDefault(); savePrice(); } });
    LINE.addEventListener("click", e => {
      const t = e.target.closest("button, a"); if (!t) return;
      if (t.id === "mgsave") { e.preventDefault(); savePrice(); }
      else if (t.id === "mgtbl") { e.preventDefault(); openTable(); }
      else if (t.id === "mgcfg") {
        e.preventDefault();
        const setup = document.getElementById("setup");   // the Settings panel (app.js opens it the same way for #settings)
        if (setup) setup.classList.add("show");
        const s = document.getElementById("setMargin");
        if (s) s.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
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
    const [q, t] = await Promise.all([
      jget("/api/margin/quote?grams=" + encodeURIComponent(grams) + "&est=" + encodeURIComponent(map.estTime || "") + "&name=" + encodeURIComponent(name)),
      jget("/api/margin/table?type=" + encodeURIComponent(typeSlug()) + "&file=" + encodeURIComponent(name))
    ]);
    if (!q || key !== LASTKEY) return;
    QUOTE = q; SAVED = (t && t.row) || null;
    render(q);
  }
  function render(q) {
    if (q.cost == null) { LINE.className = "mgline"; return; }
    const parts = [];
    parts.push('<span class="mgk">filament</span> <b>' + usd(q.cost) + "</b>");
    if (q.qty) parts.push('<span class="mgk">sell for at least</span> <b>' + usd(q.min_unit) + "</b> each <span class=\"mgk\">(" + q.qty + " on the plate, " + usd(q.min_plate) + " total)</span>");
    else parts.push('<span class="mgk">sell the plate for at least</span> <b>' + usd(q.min_plate) + '</b> <span class="mgk" title="Put the count in the file name, like &quot;Penguin x20.gcode&quot;, to see the price per piece">(no x-count in the name)</span>');
    if (q.per_hour != null) parts.push("<b>" + usd(q.per_hour) + '</b> <span class="mgk">per printer hour over ' + hrs(q.hours) + "</span>");
    const price = SAVED ? SAVED.price : "";
    LINE.innerHTML = '<div>' + parts.join('<span class="mgk">  ·  </span>') +
      '<a href="#" id="mgcfg" title="At $' + q.sell_per_g.toFixed(2) + '/g sell floor and $' + q.cost_per_g.toFixed(2) + '/g filament - change in Settings">⚙</a></div>' +
      '<div class="mgprice"><span class="mgk">sells for</span>' +
      '<input id="mgin" type="number" inputmode="decimal" min="0" step="0.25" placeholder="0.00" value="' + esc(price) + '" title="What one piece actually sells for (the whole plate, if the name has no x-count)">' +
      '<span class="mgk">' + (q.qty ? "each" : "the plate") + '</span>' +
      '<span class="mgres" id="mgres"></span>' +
      '<button class="btn ghost" id="mgsave">Save</button>' +
      '<span class="mgsaved" id="mgsaved"></span>' +
      '<a href="#" id="mgtbl" title="Every file you have priced, most profitable first">table</a></div>';
    LINE.className = "mgline show";
    preview();
  }
  // Live arithmetic while typing; the server does the same math on Save and
  // its answer replaces this (the harness pins the server's numbers).
  function preview() {
    const q = QUOTE; if (!q) return;
    const inp = LINE.querySelector("#mgin"), res = LINE.querySelector("#mgres"), sv = LINE.querySelector("#mgsaved");
    const p = parseFloat(inp.value);
    if (!Number.isFinite(p) || p < 0) { res.className = "mgres"; res.innerHTML = ""; sv.textContent = SAVED ? "saved " + when(SAVED.at) : ""; return; }
    const pieces = q.qty || 1, revenue = r2(p * pieces), perG = r2(revenue / q.grams);
    const perH = q.hours ? r2(revenue / q.hours) : null, margin = r2(revenue - q.cost);
    const low = perG < q.sell_per_g;
    res.className = "mgres " + (low ? "low" : "ok");
    res.innerHTML = '<span class="mgk">→</span> <b>' + usd(revenue) + '</b> <span class="mgk">the plate</span> <span class="mgk">·</span> <b>' + (perH != null ? usd(perH) : "—") + '</b><span class="mgk">/printer hour</span> <span class="mgk">·</span> <b>' + usd(perG) + '</b><span class="mgk">/g</span> <span class="mgk">·</span> <b>' + usd(margin) + '</b> <span class="mgk">over filament' + (low ? ", under the $" + q.sell_per_g.toFixed(2) + "/g floor" : "") + "</span>";
    sv.textContent = SAVED && SAVED.price === r2(p) ? "saved " + when(SAVED.at) : (SAVED ? "was " + usd(SAVED.price) : "");
  }
  const when = ts => { const d = new Date(ts), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
  async function savePrice() {
    const q = QUOTE, name = window.SELECTED, map = window.MAP; if (!q || !name || !map) return;
    const inp = LINE.querySelector("#mgin"), sv = LINE.querySelector("#mgsaved");
    const p = parseFloat(inp.value);
    if (!Number.isFinite(p) || p < 0) { sv.textContent = "type a price first"; return; }
    const am = map.amounts || {};
    const r = await jpost("/api/margin/price", { file: name, type: typeSlug(), price: p, grams: am.total_g != null ? am.total_g : am.slot_sum_g, est: map.estTime || "" });
    if (!r.ok) { sv.textContent = r.d.error || "could not save"; return; }
    SAVED = r.d.row;
    preview();
  }

  // ---- the table ---------------------------------------------------------------
  let MODAL = null, SORT = "per_hour";
  function ensureModal() {
    if (MODAL) return MODAL;
    MODAL = document.createElement("div");
    MODAL.className = "modal";
    MODAL.id = "mgmodal";
    MODAL.innerHTML = '<div class="modalbox" style="max-width:860px"><div class="modalhdr"><span>What sells, per printer hour</span>' +
      '<span style="margin-left:auto; display:flex; gap:8px; align-items:center"><a class="btn ghost" id="mgexport" href="#" download style="font-size:11.5px; padding:4px 10px; text-decoration:none" title="Every priced file as a spreadsheet (CSV), in the order shown">Export CSV</a>' +
      '<button class="modalx" id="mgclose" title="Close">×</button></span></div><div class="mgwrap" id="mgwrap"></div><div class="mgnote" id="mgfoot"></div></div>';
    document.body.appendChild(MODAL);
    MODAL.addEventListener("click", async e => {
      if (e.target === MODAL || e.target.id === "mgclose") { MODAL.classList.remove("show"); return; }
      const th = e.target.closest("th[data-sort]");
      if (th) { SORT = th.dataset.sort; return loadTable(); }
      const rm = e.target.closest(".mgrm");
      if (rm) {
        await jpost("/api/margin/price/remove", { file: rm.dataset.file, type: rm.dataset.type });
        if (rm.dataset.file === window.SELECTED) { SAVED = null; LASTKEY = null; refresh(); }
        return loadTable();
      }
      const go = e.target.closest("[data-go]");
      if (go && typeof window.selectFile === "function") { MODAL.classList.remove("show"); window.selectFile(go.dataset.go); }
    });
    return MODAL;
  }
  function openTable() { ensureModal().classList.add("show"); loadTable(); }
  async function loadTable() {
    const box = MODAL.querySelector("#mgwrap"), foot = MODAL.querySelector("#mgfoot");
    const ex = MODAL.querySelector("#mgexport");
    if (ex) ex.href = "/api/margin/table.csv?type=" + encodeURIComponent(typeSlug()) + "&sort=" + SORT;   // v2.30.1: the same rows, same order, as a file
    const d = await jget("/api/margin/table?type=" + encodeURIComponent(typeSlug()) + "&sort=" + SORT);
    if (!d) { box.innerHTML = '<div class="mgnote">Could not load the table.</div>'; return; }
    if (!d.rows.length) { box.innerHTML = '<div class="mgnote">Nothing priced yet. Select a file, type what a piece sells for, press Save.</div>'; foot.textContent = ""; return; }
    const cols = [["file", "File", false], ["pieces", "Pieces", false], ["price", "Each", true], ["revenue", "Plate", true], ["hours", "Hours", true], ["per_hour", "$/hr", true], ["per_g", "$/g", true], ["cost", "Filament", false], ["margin", "Margin", true], ["at", "Saved", true]];
    box.innerHTML = '<table class="mgtable"><thead><tr>' + cols.map(([k, l, s]) => "<th" + (s ? ' data-sort="' + k + '"' : "") + (SORT === k ? ' class="on"' : "") + ">" + l + (SORT === k ? " ▾" : "") + "</th>").join("") + "<th></th></tr></thead><tbody>" +
      d.rows.map(r => '<tr class="' + (r.below_floor ? "low" : "") + '"><td><a href="#" data-go="' + esc(r.file) + '" style="color:inherit; text-decoration:none">' + esc(r.file.replace(/\.gcode$/i, "")) + "</a></td>" +
        "<td>" + r.pieces + "</td><td>" + usd(r.price) + "</td><td>" + usd(r.revenue) + "</td><td>" + (r.hours != null ? r.hours.toFixed(1) : "—") + '</td><td class="hi">' + usd(r.per_hour) + '</td><td class="hi">' + usd(r.per_g) + "</td><td>" + usd(r.cost) + "</td><td>" + usd(r.margin) + (r.margin_pct != null ? ' <span style="opacity:.6">' + r.margin_pct + "%</span>" : "") + "</td><td>" + when(r.at) + '</td><td><button class="mgrm" data-file="' + esc(r.file) + '" data-type="' + esc(r.type) + '" title="Remove this row">×</button></td></tr>').join("") +
      "</tbody>" + (d.totals ? '<tfoot><tr><td>' + d.rows.length + " files</td><td></td><td></td><td>" + usd(d.totals.revenue) + "</td><td>" + d.totals.hours.toFixed(0) + "</td><td>" + (d.totals.hours ? usd(r2(d.totals.revenue / d.totals.hours)) : "—") + "</td><td></td><td></td><td>" + usd(d.totals.margin) + "</td><td></td><td></td></tr></tfoot>" : "") + "</table>";
    foot.textContent = "One row per file, the last price you saved. $/hr and $/g are what the plate brings in per printer hour and per gram of filament; rows under your $" + d.sell_per_g.toFixed(2) + "/g floor are marked. Click a column to sort, a file name to select it.";
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
      'Every selected file shows what its filament costs, the least it has to sell for (per piece when the file name carries the plate count, like <code>Penguin x20.gcode</code>), and what that comes to per printer hour. Two rates make the rule: the sell floor per gram and what filament costs you per gram. Type what a piece really sells for beside it and Save, and the "table" link lists every priced file by dollars per printer hour. Nothing is decided from any of this; it is the number to look at before you queue a plate.' +
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
