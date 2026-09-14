// public/modules/models-ui.js — the Models tab (v2.26): the 3MF library.
// Injected only when features.models is on; mounted through HubModules like
// the Dispatch and Resources tabs. Desktop only: the tab is hidden below 900px
// and on coarse pointers, because its one action opens Orca on the Hub
// computer, which is no use from a phone on the couch.
//
// Layout: creators down the left, a searchable grid of cards on the right.
// Each card is the designer's own plate thumbnail (from inside the 3MF), the
// colors the project is painted with, the object count, and "Open in Orca".
// After Orca saves, a strip at the top names the new gcode with "Select in
// library" and "Send to Dispatch".
"use strict";
(function () {
  let EL = null, DATA = null, CREATOR = "", Q = "", OFFSET = 0, BUSY = false, SESS = [], SESS_TIMER = 0, SETTINGS = null;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, d };
    } catch (e) { return { ok: false, status: 0, d: { error: e.message } }; }
  }
  const mb = n => n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB";
  const typeSlug = () => (typeof window.activeType === "function" && window.activeType().slug) || "u1";

  function style() {
    if (document.getElementById("mdlcss")) return;
    const s = document.createElement("style");
    s.id = "mdlcss";
    s.textContent = [
      "@media (max-width: 899px), (pointer: coarse) { .vtab[data-view=\"models\"] { display: none !important; } }",
      ".mdl-wrap{display:grid; grid-template-columns: 220px minmax(0,1fr); gap:14px; margin-top:12px;}",
      ".mdl-rail{background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); padding:10px; align-self:start; position:sticky; top:12px; max-height:calc(100vh - 40px); overflow:auto;}",
      ".mdl-rail button{display:flex; width:100%; justify-content:space-between; gap:8px; background:transparent; border:none; color:var(--ink-dim); font:inherit; font-size:12.5px; text-align:left; padding:6px 8px; border-radius:var(--r-sm,6px); cursor:pointer;}",
      ".mdl-rail button:hover{background:var(--panel-2,rgba(255,255,255,.04)); color:var(--ink);}",
      ".mdl-rail button.on{background:color-mix(in srgb, var(--signal) 16%, transparent); color:var(--ink); font-weight:600;}",
      ".mdl-rail .n{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".mdl-bar{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;}",
      ".mdl-bar input.field{flex:1 1 240px; min-width:0;}",
      ".mdl-grid{display:grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap:10px;}",
      ".mdl-card{background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); overflow:hidden; display:flex; flex-direction:column; min-width:0;}",
      ".mdl-thumb{aspect-ratio:1/1; background:var(--panel-2,#15171c); display:flex; align-items:center; justify-content:center; overflow:hidden;}",
      ".mdl-thumb img{width:100%; height:100%; object-fit:contain; display:block;}",
      ".mdl-thumb .nothumb{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".mdl-body{padding:9px 10px 10px; display:flex; flex-direction:column; gap:5px; min-width:0;}",
      ".mdl-name{font-size:13px; font-weight:600; color:var(--ink); line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;}",
      ".mdl-sub{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}",
      ".mdl-chips{display:flex; gap:4px; align-items:center; min-height:14px; flex-wrap:wrap;}",
      ".mdl-chip{width:14px; height:14px; border-radius:4px; border:1px solid rgba(255,255,255,.18); flex:none;}",
      ".mdl-chips .k{font-family:var(--mono); font-size:10px; color:var(--ink-faint);}",
      ".mdl-act{display:flex; gap:6px; margin-top:2px;}",
      ".mdl-act .btn{font-size:11.5px; padding:4px 9px;}",
      ".mdl-sess{background:var(--panel); border:1px solid color-mix(in srgb, var(--signal) 45%, var(--line)); border-radius:var(--r-lg,12px); padding:10px 13px; margin-bottom:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:13px;}",
      ".mdl-sess .k{font-family:var(--mono); font-size:11px; color:var(--ink-faint);}",
      ".mdl-empty{padding:30px; text-align:center; color:var(--ink-faint); font-size:13px;}",
      ".mdl-foot{display:flex; gap:10px; align-items:center; justify-content:center; padding:14px 0 4px; font-family:var(--mono); font-size:11px; color:var(--ink-faint);}",
      ".mdl-cfg{display:none; background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); padding:12px 14px; margin-bottom:10px;}",
      ".mdl-cfg.show{display:block;}",
      ".mdl-cfg label{display:block; font-size:12px; color:var(--ink-dim); margin:6px 0 3px;}",
      "@media (max-width: 1100px){ .mdl-wrap{grid-template-columns: 1fr;} .mdl-rail{position:static; max-height:none; display:flex; flex-wrap:wrap; gap:4px;} .mdl-rail button{width:auto;} }"
    ].join("\n");
    document.head.appendChild(s);
  }

  function mount(el) {
    EL = el; style();
    el.innerHTML =
      '<div class="sechead"><h2>Models</h2><span class="count" id="mdl-count"></span></div>' +
      '<p class="subnote">Project files (3MF) you have not sliced yet, organized by designer. Open one in Snapmaker Orca on this computer, slice it, save the gcode into the library, and it shows up here to select or send to Dispatch. Nothing on this tab prints anything.</p>' +
      '<div id="mdl-sess"></div>' +
      '<div class="mdl-cfg" id="mdl-cfg"></div>' +
      '<div class="mdl-bar">' +
      '<input class="field" id="mdl-q" placeholder="Filter models… (* ? -word)" title="Plain text matches anywhere in designer/model/file. * and ? are wildcards. -word excludes.">' +
      '<button class="btn ghost" id="mdl-rescan" title="Walk the folder again now">⟳ Rescan</button>' +
      '<button class="btn ghost" id="mdl-cfgbtn">⚙ Folder</button>' +
      '</div>' +
      '<div class="mdl-wrap"><div class="mdl-rail" id="mdl-rail"></div><div><div class="mdl-grid" id="mdl-grid"></div><div class="mdl-foot" id="mdl-foot"></div></div></div>';
    let t = 0;
    el.querySelector("#mdl-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { Q = e.target.value.trim(); OFFSET = 0; load(); }, 220); });
    el.querySelector("#mdl-rescan").addEventListener("click", () => { OFFSET = 0; load(true); });
    el.querySelector("#mdl-cfgbtn").addEventListener("click", () => { el.querySelector("#mdl-cfg").classList.toggle("show"); });
    el.querySelector("#mdl-grid").addEventListener("click", onGridClick);
    el.querySelector("#mdl-foot").addEventListener("click", e => { if (e.target.id === "mdl-more") { OFFSET += (DATA && DATA.limit) || 60; load(false, true); } });
    el.querySelector("#mdl-sess").addEventListener("click", onSessClick);
    renderCfg();
  }

  function renderCfg() {
    const box = EL.querySelector("#mdl-cfg");
    box.innerHTML =
      '<label>3MF folder <span class="hint">designer folders inside it become the list on the left; up to four levels deep; folders starting with _ are skipped</span></label>' +
      '<input class="field" id="mdl-folder" placeholder="X:\\_MMF" value="' + esc(DATA ? DATA.folder : "") + '">' +
      '<label>Snapmaker Orca <span class="hint">the program the Open button launches, on this computer</span></label>' +
      '<input class="field" id="mdl-orca" placeholder="C:\\Program Files\\Snapmaker_Orca\\snapmaker-orca.exe" value="' + esc(SETTINGS && SETTINGS.orcaExe ? SETTINGS.orcaExe : "") + '">' +
      '<div class="row" style="margin-top:8px; gap:8px"><button class="btn primary" id="mdl-save" style="font-size:12px; padding:5px 12px">Save</button><span class="pstatus" id="mdl-cfgmsg"></span></div>';
    box.querySelector("#mdl-save").addEventListener("click", async () => {
      const r = await jpost("/api/models/settings", { folder: box.querySelector("#mdl-folder").value, orcaExe: box.querySelector("#mdl-orca").value });
      const m = box.querySelector("#mdl-cfgmsg");
      if (!r.ok) { m.className = "pstatus err"; m.textContent = r.d.error || "Could not save"; return; }
      SETTINGS = r.d;
      m.className = "pstatus " + (r.d.folder_found ? "ok" : "err");
      m.textContent = (r.d.folder_found ? "Folder found. " : "Folder not found: " + r.d.folder + ". ") + (r.d.orca_found ? "Orca found." : "Orca not found at " + r.d.orcaExe + ".");
      CREATOR = ""; OFFSET = 0;
      setTimeout(() => load(), 800);
    });
  }

  async function load(refresh, append) {
    if (BUSY) return; BUSY = true;
    try {
      const u = "/api/models?limit=60&offset=" + OFFSET + (Q ? "&q=" + encodeURIComponent(Q) : "") + (CREATOR ? "&creator=" + encodeURIComponent(CREATOR) : "") + (refresh ? "&refresh=1" : "");
      const d = await jget(u);
      if (!d) return;
      const prev = DATA; DATA = d;
      if (!SETTINGS) SETTINGS = { orcaExe: null, orca_found: d.orca_found };
      render(append && prev ? prev.items : null);
      if (d.refreshing) setTimeout(() => { if (!BUSY) load(); }, 2500);
    } finally { BUSY = false; }
  }

  function render(prependItems) {
    const d = DATA;
    EL.querySelector("#mdl-count").textContent = d.missing ? "folder not found" : (d.total_all + " file" + (d.total_all === 1 ? "" : "s") + (d.refreshing ? " · scanning…" : ""));
    const rail = EL.querySelector("#mdl-rail");
    rail.innerHTML = '<button class="' + (CREATOR ? "" : "on") + '" data-c=""><span>All designers</span><span class="n">' + d.total_all + "</span></button>" +
      d.creators.map(c => '<button class="' + (CREATOR === c.name ? "on" : "") + '" data-c="' + esc(c.name) + '"><span>' + esc(c.name || "(no folder)") + '</span><span class="n">' + c.count + "</span></button>").join("");
    rail.querySelectorAll("button").forEach(b => b.addEventListener("click", () => { CREATOR = b.dataset.c; OFFSET = 0; load(); }));
    const grid = EL.querySelector("#mdl-grid");
    const items = (prependItems || []).concat(d.items);
    if (d.missing) {
      grid.innerHTML = '<div class="mdl-empty" style="grid-column:1/-1">No folder at <code>' + esc(d.folder) + "</code>. Point the Hub at your 3MF folder with the ⚙ Folder button above.</div>";
    } else if (!items.length) {
      grid.innerHTML = '<div class="mdl-empty" style="grid-column:1/-1">' + (d.total_all ? "Nothing matches." : (d.refreshing ? "Scanning the folder…" : "No 3MF files found under <code>" + esc(d.folder) + "</code>.")) + "</div>";
    } else {
      grid.innerHTML = items.map(card).join("");
      lazyInfo();
    }
    const foot = EL.querySelector("#mdl-foot");
    const shown = items.length;
    foot.innerHTML = d.total ? (shown + " of " + d.total + (shown < d.total ? ' · <button class="btn ghost" id="mdl-more" style="font-size:11.5px; padding:4px 10px">Show more</button>' : "")) + (d.truncated ? " · index capped" : "") : "";
    if (!SETTINGS || !SETTINGS.orcaExe) SETTINGS = { ...(SETTINGS || {}), orca_found: d.orca_found };
  }

  function card(it) {
    const q = "/api/models/thumb?file=" + encodeURIComponent(it.rel) + "&v=" + Math.round(it.mtime || 0);
    return '<div class="mdl-card" data-rel="' + esc(it.rel) + '">' +
      '<div class="mdl-thumb"><img loading="lazy" src="' + q + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'nothumb\',textContent:\'no preview in file\'}))"></div>' +
      '<div class="mdl-body">' +
      '<div class="mdl-name" title="' + esc(it.rel) + '">' + esc(it.name) + "</div>" +
      '<div class="mdl-sub">' + esc(it.creator || "") + (it.model && it.model !== it.name ? " · " + esc(it.model) : "") + " · " + mb(it.size) + "</div>" +
      '<div class="mdl-chips" data-info="' + esc(it.rel) + '"><span class="k">…</span></div>' +
      '<div class="mdl-act"><button class="btn primary" data-open="' + esc(it.rel) + '"' + (DATA && DATA.orca_found === false ? ' title="Snapmaker Orca not found - set its path under ⚙ Folder"' : "") + '>Open in Orca</button></div>' +
      "</div></div>";
  }

  // Colors and object counts come from inside each zip; fetch them only for
  // cards that are on screen, a few at a time.
  let IO = null;
  function lazyInfo() {
    if (!("IntersectionObserver" in window)) return;
    if (IO) IO.disconnect();
    IO = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const box = en.target; IO.unobserve(box);
        fillInfo(box);
      }
    }, { rootMargin: "200px" });
    EL.querySelectorAll(".mdl-chips[data-info]").forEach(b => IO.observe(b));
  }
  async function fillInfo(box) {
    const rel = box.dataset.info;
    const d = await jget("/api/models/info?file=" + encodeURIComponent(rel));
    if (!d) { box.innerHTML = '<span class="k">no project data</span>'; return; }
    const cols = (d.colors_used && d.colors_used.length ? d.colors_used : d.colors) || [];
    let h = cols.slice(0, 8).map(c => '<span class="mdl-chip" style="background:' + esc(c) + '" title="' + esc(c) + '"></span>').join("");
    const bits = [];
    if (cols.length) bits.push(cols.length + (cols.length === 1 ? " color" : " colors"));
    if (d.objects && d.objects.length) bits.push(d.objects.length + (d.objects.length === 1 ? " object" : " objects"));
    if (d.printer) bits.push("for " + d.printer);
    h += '<span class="k" title="' + esc((d.objects || []).map(o => o.name).join(", ")) + '">' + esc(bits.join(" · ") || "no project data") + "</span>";
    box.innerHTML = h;
  }

  async function onGridClick(e) {
    const b = e.target.closest("[data-open]");
    if (!b) return;
    b.disabled = true; const was = b.textContent; b.textContent = "Opening…";
    const r = await jpost("/api/models/open", { file: b.dataset.open, type: typeSlug() });
    b.disabled = false; b.textContent = was;
    if (!r.ok) { alert(r.d.error || "Could not open the file"); return; }
    pollSessions(true);
  }

  // ---- Orca sessions ----------------------------------------------------------
  async function pollSessions(now) {
    const d = await jget("/api/models/sessions");
    if (!d) return;
    SESS = d.sessions || [];
    renderSess();
    clearTimeout(SESS_TIMER);
    if (SESS.some(s => s.state === "watching")) SESS_TIMER = setTimeout(() => pollSessions(), now ? 3000 : 5000);
  }
  function renderSess() {
    const box = EL.querySelector("#mdl-sess");
    box.innerHTML = SESS.map(s => {
      const f = esc(String(s.file).split("/").pop());
      if (s.state === "watching") return '<div class="mdl-sess"><span>⏳ <b>' + f + "</b> is open in Orca. Slice it, then save the gcode into the library folder - the Hub is watching for it.</span><span class=\"k\">since " + new Date(s.launchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + '</span><button class="btn ghost" data-dismiss="' + s.id + '" style="font-size:11px; padding:3px 9px; margin-left:auto">Stop watching</button></div>';
      if (s.state === "done") return '<div class="mdl-sess"><span>✓ Orca saved <b>' + esc(s.newGcode) + "</b>.</span>" +
        '<button class="btn primary" data-select="' + esc(s.newGcode) + '" style="font-size:11.5px; padding:4px 10px">Select in library</button>' +
        (window.HUB_FEATURES && window.HUB_FEATURES.dispatch !== false ? '<button class="btn ghost" data-dispatch="' + esc(s.newGcode) + '" data-type="' + esc(s.type || "u1") + '" style="font-size:11.5px; padding:4px 10px">Send to Dispatch</button>' : "") +
        '<button class="btn ghost" data-dismiss="' + s.id + '" style="font-size:11px; padding:3px 9px; margin-left:auto">Dismiss</button></div>';
      return '<div class="mdl-sess"><span class="k">Stopped watching for ' + f + " (30 minutes passed).</span><button class=\"btn ghost\" data-dismiss=\"" + s.id + '" style="font-size:11px; padding:3px 9px; margin-left:auto">Dismiss</button></div>';
    }).join("");
  }
  async function onSessClick(e) {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.dismiss) { await jpost("/api/models/sessions/dismiss", { id: Number(t.dataset.dismiss) }); pollSessions(true); return; }
    if (t.dataset.select) {
      if (typeof window.setView === "function") window.setView("dash");
      if (typeof window.loadFiles === "function") { try { await window.loadFiles(); } catch {} }
      if (typeof window.selectFile === "function") window.selectFile(t.dataset.select);
      return;
    }
    if (t.dataset.dispatch) {
      t.disabled = true;
      const r = await jpost("/api/dispatch/jobs", { file: t.dataset.dispatch, type: t.dataset.type || "u1", qty: 1 });
      t.disabled = false;
      if (!r.ok) { alert(r.d.error || "Dispatch refused it"); return; }
      t.textContent = "Queued ✓";
    }
  }

  function onShow() { load(); pollSessions(true); }

  window.HubModules.register("models", { tab: "Models", mount, onShow });
})();
