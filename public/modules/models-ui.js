// public/modules/models-ui.js — the Models tab (v2.26): the 3MF library.
// Injected only when features.models is on; mounted through HubModules like
// the Dispatch and Resources tabs. The tab itself is hidden only below 900px
// (the two-column layout needs the room) - it's no longer gated on pointer
// type, so browsing works from a phone (typically landscape, where width
// clears 900px). The actions that only make sense at the Hub console - Open
// in Orca, the Orca session strip, the Folder settings button - stay hidden
// on coarse pointers, so touch visitors get a read-only view of the library.
//
// Layout: creators down the left, a searchable grid of cards on the right.
// Each card is the designer's own plate thumbnail (from inside the 3MF), the
// colors the project is painted with, the object count, "Open in Orca" and
// (v2.28, when the advisor module is on) "✦ Settings", which opens one panel
// above the grid with Claude's suggested slicer settings for that file on the
// printer you pick - a table of setting, value, what the designer's profile
// had, and why. After Orca saves, a strip at the top names the new gcode with
// "Select in library" and "Send to Dispatch".
// v2.30, second row: Rename (move the file to Designer\Name\Designer -
// Name.3mf, the convention), Attributes (set the designer and name the Hub
// should use for it, then the same rename offer) and Delete (permanent, one
// confirm). All three confirm inline on the card - no browser dialogs.
"use strict";
(function () {
  let EL = null, DATA = null, CREATOR = "", Q = "", OFFSET = 0, BUSY = false, SESS = [], SESS_TIMER = 0, SETTINGS = null;
  let ADV = null, ADVFILE = null;   // v2.28: /api/advisor state (key_set), the file the suggestion panel is open for
  // v2.33: the order the shelf is shown in, remembered per browser; SEED is
  // the shuffle the server dealt, sent back so "Show more" pages the same one.
  const SORTS = { designer: "Designer A-Z", name: "Name A-Z", newest: "Newest first", oldest: "Oldest first", printed: "Most printed", random: "Random" };
  let SORT = "designer", SEED = 0;
  try { const v = localStorage.getItem("u1.models.sort"); if (v && SORTS[v]) SORT = v; } catch {}
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
      "@media (max-width: 899px) { .vtab[data-view=\"models\"] { display: none !important; } }",
      // v2.27: coarse pointers (phones/tablets) keep the tab, lose the actions
      // that only do something at the Hub console itself.
      "@media (pointer: coarse) { .mdl-act, #mdl-sess, #mdl-cfgbtn { display: none !important; } }",
      "@media (pointer: coarse) { .mdl-act2, .mdl-edit, .mdl-more { display: none !important; } }",
      ".mdl-wrap{display:grid; grid-template-columns: 220px minmax(0,1fr); gap:14px; margin-top:12px;}",
      ".mdl-rail{background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); padding:10px; align-self:start; position:sticky; top:12px; max-height:calc(100vh - 40px); overflow:auto;}",
      ".mdl-rail button{display:flex; width:100%; justify-content:space-between; gap:8px; background:transparent; border:none; color:var(--ink-dim); font:inherit; font-size:12.5px; text-align:left; padding:6px 8px; border-radius:var(--r-sm,6px); cursor:pointer;}",
      ".mdl-rail button:hover{background:var(--panel-2,rgba(255,255,255,.04)); color:var(--ink);}",
      ".mdl-rail button.on{background:color-mix(in srgb, var(--signal) 16%, transparent); color:var(--ink); font-weight:600;}",
      ".mdl-rail .n{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".mdl-bar{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;}",
      ".mdl-bar input.field{flex:1 1 240px; min-width:0;}",
      ".mdl-bar select.field{flex:0 0 auto; width:auto; padding-right:26px;}",
      ".mdl-sub .prints{color:var(--ink); font-weight:600;}",
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
      ".mdl-act{display:flex; gap:6px; margin-top:2px; flex-wrap:wrap;}",
      ".mdl-act .btn{font-size:11.5px; padding:4px 9px;}",
      // v2.30: the second row of card actions (rename to the convention,
      // attributes, delete) and the inline editor / confirm they open. No
      // browser dialogs: a confirm is a second click on the same card.
      ".mdl-act2{display:none; gap:6px; margin-top:-1px; flex-wrap:wrap;}",
      ".mdl-card.more .mdl-act2{display:flex;}",
      ".mdl-card{position:relative;}",
      ".mdl-card .mdl-more{position:absolute; top:8px; right:8px; z-index:2; padding:2px 8px; font-size:13px; line-height:1.2; letter-spacing:1px; background:color-mix(in srgb, var(--panel) 82%, transparent); opacity:.75;}",
      ".mdl-card:hover .mdl-more, .mdl-card.more .mdl-more, .mdl-card .mdl-more:focus-visible{opacity:1;}",
      ".mdl-card.more .mdl-more{color:var(--ink); border-color:var(--ink-faint);}",
      ".mdl-sub .grp{font-size:9.5px; padding:0 5px; border:1px solid var(--line); border-radius:4px; color:var(--ink-dim);}",
      ".mdl-act2 .btn{font-size:11px; padding:3px 8px; color:var(--ink-dim);}",
      ".mdl-act2 .btn.danger{color:var(--bad,#e5484d); border-color:color-mix(in srgb, var(--bad,#e5484d) 45%, var(--line));}",
      ".mdl-edit{display:none; flex-direction:column; gap:6px; margin-top:4px; padding:8px; border:1px solid color-mix(in srgb, var(--signal) 40%, var(--line)); border-radius:var(--r-sm,6px); background:var(--panel-2);}",
      ".mdl-edit.show{display:flex;}",
      ".mdl-edit label{font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint);}",
      ".mdl-edit input{font:inherit; font-size:12.5px; color:var(--ink); background:var(--panel); border:1px solid var(--line); border-radius:var(--r-sm,6px); padding:5px 7px; width:100%;}",
      ".mdl-edit .tgt{font-family:var(--mono); font-size:10.5px; color:var(--ink-dim); word-break:break-all; line-height:1.4;}",
      ".mdl-edit .tgt b{color:var(--ink); font-weight:600;}",
      ".mdl-edit .row{display:flex; gap:6px; flex-wrap:wrap; align-items:center;}",
      ".mdl-edit .msg{font-size:11.5px; color:var(--ink-dim);}",
      ".mdl-edit .msg.err{color:var(--bad,#e5484d);}",
      ".mdl-card.conv .mdl-sub::before{content:'✓ '; color:var(--ok,#3DD68C);}",
      ".mdl-sess{background:var(--panel); border:1px solid color-mix(in srgb, var(--signal) 45%, var(--line)); border-radius:var(--r-lg,12px); padding:10px 13px; margin-bottom:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:13px;}",
      ".mdl-sess .k{font-family:var(--mono); font-size:11px; color:var(--ink-faint);}",
      ".mdl-empty{padding:30px; text-align:center; color:var(--ink-faint); font-size:13px;}",
      ".mdl-foot{display:flex; gap:10px; align-items:center; justify-content:center; padding:14px 0 4px; font-family:var(--mono); font-size:11px; color:var(--ink-faint);}",
      ".mdl-cfg{display:none; background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); padding:12px 14px; margin-bottom:10px;}",
      ".mdl-cfg.show{display:block;}",
      ".mdl-cfg label{display:block; font-size:12px; color:var(--ink-dim); margin:6px 0 3px;}",
      // v2.28: the settings suggestion panel (✦ Settings on a card).
      ".mdl-adv{display:none; background:var(--panel); border:1px solid color-mix(in srgb, var(--signal) 45%, var(--line)); border-radius:var(--r-lg,12px); padding:12px 14px; margin-bottom:10px; font-size:13px; line-height:1.5;}",
      ".mdl-adv.show{display:block;}",
      ".mdl-adv .ah{display:flex; gap:10px; align-items:center; flex-wrap:wrap;}",
      ".mdl-adv .ah img{width:56px; height:56px; object-fit:contain; border-radius:var(--r-sm,6px); background:var(--panel-2,#15171c); flex:none;}",
      ".mdl-adv .ah .t{font-weight:600; color:var(--ink); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1 1 200px;}",
      ".mdl-adv .ah select.field{width:auto; flex:0 0 auto; font-size:12px; padding:4px 8px;}",
      ".mdl-adv .ah .x{margin-left:auto; background:transparent; border:none; color:var(--ink-faint); font:inherit; font-size:16px; cursor:pointer; padding:2px 6px;}",
      ".mdl-adv .st{color:var(--ink-dim); font-size:12.5px; margin-top:6px;}",
      ".mdl-adv .st.err{color:var(--bad,#e5484d);}",
      ".mdl-adv .sum{margin:8px 0 6px; color:var(--ink);}",
      ".mdl-adv table{width:100%; border-collapse:collapse; font-size:12.5px; margin-top:4px;}",
      ".mdl-adv th{text-align:left; font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint); padding:4px 8px 6px 0; border-bottom:1px solid var(--line);}",
      ".mdl-adv td{padding:5px 8px 5px 0; border-bottom:1px solid color-mix(in srgb, var(--line) 55%, transparent); vertical-align:top;}",
      ".mdl-adv td.k{font-family:var(--mono); font-size:11px; color:var(--ink-dim); white-space:nowrap;}",
      ".mdl-adv td.v{font-weight:600; color:var(--ink); white-space:nowrap;}",
      ".mdl-adv td.f{font-family:var(--mono); font-size:11px; color:var(--ink-faint); white-space:nowrap; text-decoration:line-through;}",
      ".mdl-adv td.w{color:var(--ink-dim);}",
      ".mdl-adv .heads{display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;}",
      ".mdl-adv .heads span{display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11px; color:var(--ink-dim); border:1px solid var(--line); border-radius:var(--r-pill,999px); padding:2px 8px;}",
      ".mdl-adv .heads i{width:10px; height:10px; border-radius:3px; border:1px solid rgba(255,255,255,.18); display:inline-block;}",
      ".mdl-adv ul.watch{margin:8px 0 0 18px; padding:0;}",
      ".mdl-adv ul.watch li{margin:3px 0; color:var(--ink);}",
      ".mdl-adv .facts{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); margin-top:8px; line-height:1.6;}",
      ".mdl-adv .foot{margin-top:8px; font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); display:flex; gap:10px; flex-wrap:wrap; align-items:center;}",
      "@media (max-width: 700px){ .mdl-adv td.v, .mdl-adv td.k{white-space:normal;} }",
      "@media (max-width: 1100px){ .mdl-wrap{grid-template-columns: 1fr;} .mdl-rail{position:static; max-height:none; display:flex; flex-wrap:wrap; gap:4px;} .mdl-rail button{width:auto;} }"
    ].join("\n");
    document.head.appendChild(s);
  }

  function mount(el) {
    EL = el; style();
    el.innerHTML =
      '<div class="sechead"><h2>Models</h2><span class="count" id="mdl-count"></span></div>' +
      '<p class="subnote">3MF projects you have not sliced yet. Open one in Orca, save the gcode, and it lands in the library.</p>' +
      '<div id="mdl-sess"></div>' +
      '<div class="mdl-adv" id="mdl-adv"></div>' +
      '<div class="mdl-cfg" id="mdl-cfg"></div>' +
      '<div class="mdl-bar">' +
      '<input class="field" id="mdl-q" placeholder="Filter models… (* ? -word)" title="Plain text matches anywhere in designer/model/file. * and ? are wildcards. -word excludes.">' +
      '<select class="field" id="mdl-sort" title="Order the shelf is shown in">' + Object.keys(SORTS).map(k => '<option value="' + k + '"' + (k === SORT ? " selected" : "") + ">" + SORTS[k] + "</option>").join("") + "</select>" +
      '<button class="btn ghost" id="mdl-shuffle" title="Deal a new random order"' + (SORT === "random" ? "" : ' style="display:none"') + '>🎲 Shuffle</button>' +
      '<button class="btn ghost" id="mdl-rescan" title="Walk the folder again now">⟳ Rescan</button>' +
      '<button class="btn ghost" id="mdl-cfgbtn">⚙ Folder</button>' +
      '</div>' +
      '<div class="mdl-wrap"><div class="mdl-rail" id="mdl-rail"></div><div><div class="mdl-grid" id="mdl-grid"></div><div class="mdl-foot" id="mdl-foot"></div></div></div>';
    let t = 0;
    el.querySelector("#mdl-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { Q = e.target.value.trim(); OFFSET = 0; load(); }, 220); });
    el.querySelector("#mdl-rescan").addEventListener("click", () => { OFFSET = 0; load(true); });
    el.querySelector("#mdl-sort").addEventListener("change", e => {
      SORT = SORTS[e.target.value] ? e.target.value : "designer";
      try { localStorage.setItem("u1.models.sort", SORT); } catch {}
      el.querySelector("#mdl-shuffle").style.display = SORT === "random" ? "" : "none";
      SEED = 0; OFFSET = 0; load();
    });
    el.querySelector("#mdl-shuffle").addEventListener("click", () => { SEED = 0; OFFSET = 0; load(); });
    el.querySelector("#mdl-cfgbtn").addEventListener("click", () => { el.querySelector("#mdl-cfg").classList.toggle("show"); });
    el.querySelector("#mdl-grid").addEventListener("click", onGridClick);
    el.querySelector("#mdl-grid").addEventListener("keydown", e => {
      const box = e.target.closest(".mdl-edit");
      if (!box) return;
      if (e.key === "Enter") { e.preventDefault(); if (box.querySelector("[data-save-attrs]")) saveAttrs(box.dataset.edit); }
      if (e.key === "Escape") closeEdit(box.dataset.edit);
    });
    el.querySelector("#mdl-foot").addEventListener("click", e => { if (e.target.id === "mdl-more") { OFFSET += (DATA && DATA.limit) || 60; load(false, true); } });
    el.querySelector("#mdl-sess").addEventListener("click", onSessClick);
    el.querySelector("#mdl-adv").addEventListener("click", onAdvClick);
    renderCfg();
    jget("/api/advisor").then(s => { ADV = s; });
  }

  // v2.27.1: the fields are filled from the server's answer, and re-filled
  // when it arrives, so the form never shows blanks for values that are set.
  // (It did, and a Save pressed on the blanks wiped the folder - 2026-09-22.)
  function renderCfg() {
    const box = EL.querySelector("#mdl-cfg");
    if (box.querySelector("#mdl-folder") && (document.activeElement === box.querySelector("#mdl-folder") || document.activeElement === box.querySelector("#mdl-orca"))) return;
    const folder = DATA && DATA.folder ? DATA.folder : "";
    const orca = DATA && DATA.orcaExe ? DATA.orcaExe : (SETTINGS && SETTINGS.orcaExe ? SETTINGS.orcaExe : "");
    box.innerHTML =
      '<label>3MF folder <span class="hint">designer folders inside it become the list on the left; up to four levels deep; folders starting with _ are skipped</span></label>' +
      '<input class="field" id="mdl-folder" placeholder="' + (folder ? "" : "loading…") + '" value="' + esc(folder) + '">' +
      '<label>Snapmaker Orca <span class="hint">the program the Open button launches, on this computer</span></label>' +
      '<input class="field" id="mdl-orca" placeholder="C:\\Program Files\\Snapmaker_Orca\\snapmaker-orca.exe" value="' + esc(orca) + '">' +
      '<div class="row" style="margin-top:8px; gap:8px"><button class="btn primary" id="mdl-save" style="font-size:12px; padding:5px 12px">Save</button><span class="pstatus" id="mdl-cfgmsg"></span></div>';
    box.querySelector("#mdl-save").addEventListener("click", async () => {
      const fv = box.querySelector("#mdl-folder").value.trim();
      if (!fv) { const m = box.querySelector("#mdl-cfgmsg"); m.className = "pstatus err"; m.textContent = "Enter the folder path (it was left blank)."; return; }
      const r = await jpost("/api/models/settings", { folder: fv, orcaExe: box.querySelector("#mdl-orca").value });
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
      const u = "/api/models?limit=60&offset=" + OFFSET + (Q ? "&q=" + encodeURIComponent(Q) : "") + (CREATOR ? "&creator=" + encodeURIComponent(CREATOR) : "") + (refresh ? "&refresh=1" : "")
        + (SORT !== "designer" ? "&sort=" + SORT : "") + (SORT === "random" && SEED ? "&seed=" + SEED : "");
      const d = await jget(u);
      if (!d) return;
      if (d.sort === "random" && d.seed) SEED = d.seed;
      const prev = DATA; DATA = d;
      SETTINGS = { ...(SETTINGS || {}), orcaExe: d.orcaExe || (SETTINGS && SETTINGS.orcaExe) || null, orca_found: d.orca_found };
      render(append && prev ? prev.items : null);
      if (!prev || prev.folder !== d.folder) renderCfg();
      // While a scan is running and there is nothing to show yet, poll.
      if ((d.refreshing || d.scanning) && !d.items.length) setTimeout(() => { if (!BUSY) load(); }, 2500);
    } finally { BUSY = false; }
  }

  function render(prependItems) {
    const d = DATA;
    EL.querySelector("#mdl-count").textContent = d.missing ? "folder not found"
      : (d.scanning && !d.total_all) ? "scanning the folder…"
      : (d.total_all + " file" + (d.total_all === 1 ? "" : "s") + (d.refreshing ? " · rescanning…" : "") + (d.unreachable ? " · folder not reachable right now, showing the last scan" : ""));
    const rail = EL.querySelector("#mdl-rail");
    rail.innerHTML = '<button class="' + (CREATOR ? "" : "on") + '" data-c=""><span>All designers</span><span class="n">' + d.total_all + "</span></button>" +
      d.creators.map(c => { const v = c.name || "__none__"; return '<button class="' + (CREATOR === v ? "on" : "") + '" data-c="' + esc(v) + '"><span>' + esc(c.name || "(no folder)") + '</span><span class="n">' + c.count + "</span></button>"; }).join("");
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
    const pnote = d.printed ? (d.printed.printers ? " · prints counted from " + d.printed.printers + " of " + d.printed.of + " printer" + (d.printed.of === 1 ? "" : "s") + "' history (" + d.printed.matched + " of " + d.printed.jobs + " completed jobs matched a file here)" : " · no printer answered for its job history, so nothing is counted yet") : "";
    foot.innerHTML = d.total ? (shown + " of " + d.total + (shown < d.total ? ' · <button class="btn ghost" id="mdl-more" style="font-size:11.5px; padding:4px 10px">Show more</button>' : "")) + (d.truncated ? " · index capped" : "") + pnote : "";
    if (!SETTINGS || !SETTINGS.orcaExe) SETTINGS = { ...(SETTINGS || {}), orca_found: d.orca_found };
  }

  function card(it) {
    const q = "/api/models/thumb?file=" + encodeURIComponent(it.rel) + "&v=" + Math.round(it.mtime || 0);
    return '<div class="mdl-card' + (it.conventional ? " conv" : "") + '" data-rel="' + esc(it.rel) + '">' +
      '<button class="btn ghost mdl-more" data-more="' + esc(it.rel) + '" title="Rename, attributes, delete" aria-label="More">⋯</button>' +
      '<div class="mdl-thumb"><img loading="lazy" src="' + q + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'nothumb\',textContent:\'no preview in file\'}))"></div>' +
      '<div class="mdl-body">' +
      '<div class="mdl-name" title="' + esc(it.rel) + '">' + esc(it.name) + "</div>" +
      '<div class="mdl-sub" title="' + (it.conventional ? "filed the way the convention wants it" : esc(it.rel)) + '">' + (it.prints != null ? '<span class="prints" title="completed prints of gcode sliced from this file, from the printers\' own job history">printed ' + it.prints + "×</span> · " : "") + (it.group ? '<span class="grp" title="format folder">' + esc(it.group) + "</span> " : "") + esc(it.creator || "") + (it.model && it.model !== it.name ? " · " + esc(it.model) : "") + " · " + mb(it.size) + "</div>" +
      '<div class="mdl-chips" data-info="' + esc(it.rel) + '"><span class="k">…</span></div>' +
      '<div class="mdl-act"><button class="btn primary" data-open="' + esc(it.rel) + '"' + (DATA && DATA.orca_found === false ? ' title="Snapmaker Orca not found - set its path under ⚙ Folder"' : "") + '>Open in Orca</button>' +
      (window.HUB_FEATURES && window.HUB_FEATURES.advisor === false ? "" : '<button class="btn ghost" data-suggest="' + esc(it.rel) + '" title="Have Claude read this file\'s geometry and the designer\'s profile and suggest the slicer settings for your printer">✦ Settings</button>') +
      '</div>' +
      '<div class="mdl-act2">' +
      '<button class="btn ghost" data-rename="' + esc(it.rel) + '" title="' + (it.conventional ? "Already filed as Designer\\Name\\Designer - Name.3mf" : "Move to Designer\\Name\\Designer - Name.3mf") + '"' + (it.conventional ? " disabled" : "") + '>Rename</button>' +
      '<button class="btn ghost" data-attrs="' + esc(it.rel) + '" title="Set or change the designer and name">Attributes</button>' +
      '<button class="btn ghost danger" data-del="' + esc(it.rel) + '" title="Delete this file from the folder">Delete</button>' +
      '</div>' +
      '<div class="mdl-edit" data-edit="' + esc(it.rel) + '"></div>' +
      "</div></div>";
  }

  // ---- v2.30: rename / attributes / delete, all inline on the card ---------
  function cardOf(rel) { return EL.querySelector('.mdl-card[data-rel="' + CSS.escape(rel) + '"]'); }
  function editBox(rel) { const c = cardOf(rel); return c ? c.querySelector(".mdl-edit") : null; }
  function closeEdit(rel) { const b = editBox(rel); if (b) { b.className = "mdl-edit"; b.innerHTML = ""; } }
  function itemOf(rel) { return (DATA && DATA.items || []).find(x => x.rel === rel) || null; }
  const tgtHtml = (t, cur) => t ? '<div class="tgt">→ <b>' + esc(t).replace(/\//g, "\\") + "</b>" + (t === cur ? ' <span style="color:var(--ok,#3DD68C)">(already there)</span>' : "") + "</div>" : "";

  async function openAttrs(rel) {
    const box = editBox(rel); if (!box) return;
    const it = itemOf(rel) || {};
    const t = await jget("/api/models/target?file=" + encodeURIComponent(rel));
    const a = it.attrs || {};
    box.className = "mdl-edit show";
    box.innerHTML =
      '<label>Designer</label><input type="text" data-f="designer" value="' + esc(a.designer || (t && t.designer) || "") + '" placeholder="who made it" spellcheck="false">' +
      '<label>Name</label><input type="text" data-f="name" value="' + esc(a.name || (t && t.title) || "") + '" placeholder="what it is" spellcheck="false">' +
      '<div class="tgt" data-preview></div>' +
      '<div class="row"><button class="btn primary" data-save-attrs="' + esc(rel) + '" style="font-size:11.5px; padding:4px 10px">Save</button><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Cancel</button><span class="msg" data-msg></span></div>';
    const preview = () => {
      const d = box.querySelector('[data-f="designer"]').value.trim(), n = box.querySelector('[data-f="name"]').value.trim();
      box.querySelector("[data-preview]").innerHTML = d && n ? tgtHtml(d + "/" + n + "/" + d + " - " + n + ".3mf", rel) : '<span style="color:var(--ink-faint)">both fields make the file\'s place: Designer\\Name\\Designer - Name.3mf</span>';
    };
    box.querySelectorAll("input").forEach(i => i.addEventListener("input", preview));
    box.querySelector('[data-f="designer"]').focus();
    preview();
  }
  async function saveAttrs(rel) {
    const box = editBox(rel); if (!box) return;
    const msg = box.querySelector("[data-msg]");
    const r = await jpost("/api/models/attrs", { file: rel, designer: box.querySelector('[data-f="designer"]').value, name: box.querySelector('[data-f="name"]').value });
    if (!r.ok) { msg.className = "msg err"; msg.textContent = r.d.error || "could not save"; return; }
    if (r.d.item && DATA) { const i = DATA.items.findIndex(x => x.rel === rel); if (i >= 0) DATA.items[i] = r.d.item; }
    const it = r.d.item;
    // Saved. Now the offer: rename to where these attributes say it belongs.
    box.innerHTML = '<div class="msg">Saved.</div>' + (it && it.target && !it.conventional
      ? tgtHtml(it.target, rel) + '<div class="row"><button class="btn primary" data-do-rename="' + esc(rel) + '" style="font-size:11.5px; padding:4px 10px">Move and rename</button><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Not now</button></div>'
      : '<div class="row"><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Close</button></div>');
    const c = cardOf(rel);
    if (c && it) {
      c.querySelector(".mdl-name").textContent = it.name;
      c.querySelector(".mdl-sub").textContent = (it.prints != null ? "printed " + it.prints + "× · " : "") + (it.group ? it.group + " · " : "") + (it.creator || "") + (it.model && it.model !== it.name ? " · " + it.model : "") + " · " + mb(it.size);
      // New attributes can move the file's proper place: the ✓ and the Rename button follow.
      c.classList.toggle("conv", !!it.conventional);
      const rb = c.querySelector("[data-rename]"); if (rb) rb.disabled = !!it.conventional;
    }
  }
  async function askRename(rel) {
    const box = editBox(rel); if (!box) return;
    const t = await jget("/api/models/target?file=" + encodeURIComponent(rel));
    box.className = "mdl-edit show";
    if (!t) { box.innerHTML = '<div class="msg err">Could not work out where it goes.</div>'; return; }
    if (t.missing.length) { box.innerHTML = '<div class="msg">No ' + t.missing.join(" or ") + ' to file it under yet - set it first.</div><div class="row"><button class="btn primary" data-attrs="' + esc(rel) + '" style="font-size:11.5px; padding:4px 10px">Attributes</button><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Cancel</button></div>'; return; }
    if (t.already) { box.innerHTML = '<div class="msg">Already filed the way the convention wants it.</div><div class="row"><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Close</button></div>'; return; }
    box.innerHTML = tgtHtml(t.target, rel) + '<div class="row"><button class="btn primary" data-do-rename="' + esc(rel) + '" style="font-size:11.5px; padding:4px 10px">Move and rename</button><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Cancel</button><span class="msg" data-msg></span></div>';
  }
  async function doRename(rel) {
    const box = editBox(rel); const msg = box && box.querySelector("[data-msg]");
    if (msg) msg.textContent = "moving…";
    const r = await jpost("/api/models/rename", { file: rel });
    if (!r.ok) { if (msg) { msg.className = "msg err"; msg.textContent = r.d.error || "could not rename"; } return; }
    if (ADVFILE === rel) ADVFILE = r.d.rel;
    // The list is the truth; redraw it rather than patch a card that has moved designers.
    OFFSET = 0; await load();
  }
  function askDelete(rel) {
    const box = editBox(rel); if (!box) return;
    box.className = "mdl-edit show";
    box.innerHTML = '<div class="msg">Delete <b>' + esc(rel.split("/").pop()) + '</b> from the folder? There is no undo.</div><div class="row"><button class="btn primary" data-do-del="' + esc(rel) + '" style="font-size:11.5px; padding:4px 10px; background:var(--bad,#e5484d); border-color:var(--bad,#e5484d); color:#fff">Delete for good</button><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Keep it</button><span class="msg" data-msg></span></div>';
  }
  async function doDelete(rel) {
    const box = editBox(rel); const msg = box && box.querySelector("[data-msg]");
    const r = await jpost("/api/models/delete", { file: rel });
    if (!r.ok) { if (msg) { msg.className = "msg err"; msg.textContent = r.d.error || "could not delete"; } return; }
    const c = cardOf(rel); if (c) c.remove();
    if (DATA) { DATA.items = DATA.items.filter(x => x.rel !== rel); DATA.total = Math.max(0, DATA.total - 1); DATA.total_all = Math.max(0, DATA.total_all - 1); }
    if (ADVFILE === rel) { const adv = EL.querySelector("#mdl-adv"); adv.className = "mdl-adv"; adv.innerHTML = ""; ADVFILE = null; }
    EL.querySelector("#mdl-count").textContent = DATA.total_all + " file" + (DATA.total_all === 1 ? "" : "s");
  }

  // ---- ✦ Settings: the 3MF suggester (v2.28) ----------------------------------
  // One panel above the grid, for one file at a time. Nothing is sent until
  // Ask is pressed (opening the panel with a key set presses it for you, the
  // same as the job-card pre-flight); the answer is a settings table.
  const money = v => v == null ? "" : (v < 0.01 ? "under a cent" : "$" + v.toFixed(2));
  function printers() {
    const slug = typeSlug();
    return (window.FLEET || []).filter(p => (p.ptype || "u1") === slug);
  }
  function pickPrinter() {
    const sel = EL.querySelector("#mdl-advprinter");
    if (sel && sel.value !== "") return Number(sel.value);
    if (sel && sel.value === "") return null;
    const ps = printers();
    const idle = ps.find(p => p.online && /standby|complete|cancelled|idle/i.test(p.state || "")) || ps.find(p => p.online) || ps[0];
    return idle ? idle.id : null;
  }
  function openSuggest(rel) {
    const box = EL.querySelector("#mdl-adv");
    ADVFILE = rel;
    const name = String(rel).split("/").pop();
    const thumb = "/api/models/thumb?file=" + encodeURIComponent(rel);
    if (!(ADV && ADV.key_set)) {
      box.className = "mdl-adv show";
      box.innerHTML = '<div class="ah"><img src="' + thumb + '" alt="" onerror="this.style.visibility=\'hidden\'"><span class="t" title="' + esc(rel) + '">' + esc(name) + '</span><button class="x" data-close="1" title="Close">×</button></div>' +
        '<div class="st">Suggesting settings needs your Anthropic API key. Open <b>Settings → AI pre-flight</b>, paste the key, press Save, then press ✦ Settings again. Nothing is sent until then.</div>';
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    const ps = printers();
    const def = pickPrinter();
    box.className = "mdl-adv show";
    box.innerHTML =
      '<div class="ah"><img src="' + thumb + '" alt="" onerror="this.style.visibility=\'hidden\'"><span class="t" title="' + esc(rel) + '">' + esc(name) + '</span>' +
      '<span class="st" style="margin:0">for</span><select class="field" id="mdl-advprinter"><option value="">any U1 (no loadout)</option>' + ps.map(p => '<option value="' + p.id + '"' + (p.id === def ? " selected" : "") + ">" + esc(p.name) + (p.online ? "" : " (offline)") + "</option>").join("") + "</select>" +
      '<button class="btn primary" id="mdl-advask" style="font-size:12px; padding:5px 12px">Ask</button>' +
      '<button class="x" data-close="1" title="Close">×</button></div>' +
      '<div class="st" id="mdl-advst"></div><div id="mdl-advbody"></div><div class="foot" id="mdl-advfoot"></div>';
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    runSuggest(false);
  }
  async function runSuggest(force) {
    const box = EL.querySelector("#mdl-adv"), st = box.querySelector("#mdl-advst"), body = box.querySelector("#mdl-advbody"), foot = box.querySelector("#mdl-advfoot");
    if (!st) return;
    const rel = ADVFILE, pid = pickPrinter();
    st.className = "st"; st.textContent = force ? "Asking again… (measuring the meshes and reading the plate render, then Claude)" : "Measuring the meshes, then asking Claude…";
    const btn = box.querySelector("#mdl-advask"); if (btn) btn.disabled = true;
    const r = await jpost("/api/advisor/model", { file: rel, printer: pid == null ? "" : pid, force: !!force });
    if (btn) btn.disabled = false;
    if (ADVFILE !== rel) return;   // they opened another file meanwhile
    if (!r.ok) { st.className = "st err"; st.textContent = r.d.error || "The suggestion failed."; return; }
    st.textContent = "";
    const s = r.d.suggestion || {};
    let h = s.summary ? '<div class="sum">' + esc(s.summary) + "</div>" : "";
    if (s.settings && s.settings.length) {
      h += '<table><thead><tr><th>Setting</th><th>Use</th><th>File had</th><th>Why</th></tr></thead><tbody>' +
        s.settings.map(x => '<tr><td class="k" title="' + esc(x.key) + '">' + esc(x.label || x.key) + (x.label && x.key && x.label !== x.key ? '<br><span style="opacity:.7">' + esc(x.key) + "</span>" : "") + '</td><td class="v">' + esc(x.value) + '</td><td class="f">' + esc(x.from || "") + '</td><td class="w">' + esc(x.why) + "</td></tr>").join("") + "</tbody></table>";
    }
    if (s.heads && s.heads.length) h += '<div class="heads">' + s.heads.map(x => '<span title="' + esc(x.note) + '"><i style="background:' + esc(x.color) + '"></i>' + esc(x.color) + " → " + esc(x.head) + (x.note ? " · " + esc(x.note) : "") + "</span>").join("") + "</div>";
    if (s.orientation) h += '<div class="st" style="margin-top:8px"><b>Orientation:</b> ' + esc(s.orientation) + "</div>";
    if (s.watch && s.watch.length) h += '<ul class="watch">' + s.watch.map(w => "<li>" + esc(w) + "</li>").join("") + "</ul>";
    const f = r.d.facts;
    if (f && f.ok) h += '<div class="facts">measured: ' + f.size_mm.join(" × ") + " mm · " + f.instances + " part" + (f.instances === 1 ? "" : "s") + " · " + f.overhang.steep_pct + "% steep overhang · " + f.overhang.flat_unsupported_pct + "% floating underside · bed contact " + f.overhang.bed_contact_pct_of_footprint + "% of footprint · " + f.solid_g_pla + " g solid" + (f.paint && f.paint.colors ? " · painted " + f.paint.colors + " colors" : "") + (r.d.thumb ? " · plate render sent" : " · no plate render in the file") + "</div>";
    body.innerHTML = h || '<div class="st">No settings came back.</div>';
    const when = new Date(r.d.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    foot.innerHTML = esc(r.d.model || "") + (r.d.cost != null ? " · " + money(r.d.cost) : "") + " · " + (r.d.cached ? "from cache, " + when : when) +
      ' · <a href="#" data-again="1" style="color:var(--signal)">Ask again</a>' +
      ' · <a href="/api/advisor/model/brief?file=' + encodeURIComponent(rel) + (pid != null ? "&printer=" + pid : "") + '" target="_blank" rel="noopener" style="color:var(--signal)">what was sent</a>' +
      ' · <span title="Claude reads measured numbers, the plate render and the designer\'s profile; it does not slice the file.">advice, not a guarantee</span>';
  }
  function onAdvClick(e) {
    const t = e.target.closest("button, a"); if (!t) return;
    if (t.dataset.close) { const box = EL.querySelector("#mdl-adv"); box.className = "mdl-adv"; box.innerHTML = ""; ADVFILE = null; return; }
    if (t.id === "mdl-advask") { runSuggest(false); return; }
    if (t.dataset.again) { e.preventDefault(); runSuggest(true); }
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
    const sg = e.target.closest("[data-suggest]");
    if (sg) { openSuggest(sg.dataset.suggest); return; }
    const t = e.target.closest("button");
    // v2.36: Rename / Attributes / Delete live behind ⋯ - three buttons on
    // every card was 180 extra buttons a page for things done now and then.
    if (t && t.dataset.more != null) { const c = cardOf(t.dataset.more); if (c) { const open = c.classList.toggle("more"); if (!open) closeEdit(t.dataset.more); } return; }
    if (t && t.dataset.rename != null) { closeEdit(t.dataset.rename); askRename(t.dataset.rename); return; }
    if (t && t.dataset.attrs != null) { closeEdit(t.dataset.attrs); openAttrs(t.dataset.attrs); return; }
    if (t && t.dataset.del != null) { closeEdit(t.dataset.del); askDelete(t.dataset.del); return; }
    if (t && t.dataset.saveAttrs != null) { saveAttrs(t.dataset.saveAttrs); return; }
    if (t && t.dataset.doRename != null) { doRename(t.dataset.doRename); return; }
    if (t && t.dataset.doDel != null) { doDelete(t.dataset.doDel); return; }
    if (t && t.dataset.cancel != null) { closeEdit(t.dataset.cancel); return; }
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

  function onShow() { load(); pollSessions(true); jget("/api/advisor").then(s => { if (s) ADV = s; }); }

  window.HubModules.register("models", { tab: "Models", mount, onShow });
})();
