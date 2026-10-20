// public/modules/models-ui.js — the Models tab (v2.26): the 3MF library.
// Injected only when features.models is on; mounted through HubModules like
// the Dispatch and Resources tabs.
// v2.44 (H21/H22/F13): the tab works on a phone. The designer rail shows the
// top twelve by count plus a typeahead over the rest (no more 600-chip cloud
// above the cards), the shelf opens newest-first, the gcode sidebar folds
// away behind a Library button on narrow screens so the cards get the width,
// and every action that works over HTTP - Convert to U1, Link gcode,
// Attributes, Rename, Delete - is reachable from the card's \u22ef menu on touch
// too. Only Open in Orca and the Orca session strip are console-only, since
// they launch a program on the Hub computer. Touch is no longer read-only.
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
// v2.38, first in that row: Convert to U1 (issue #5) - writes "<name>
// (U1).3mf" beside the file with the designer's prime tower, walls, infill
// and supports kept and the U1's printer and filament presets, then says
// what it kept and offers Open in Orca on the copy.
"use strict";
(function () {
  let EL = null, DATA = null, CREATOR = "", Q = "", OFFSET = 0, BUSY = false, SESS = [], SESS_TIMER = 0, SETTINGS = null;
  let ADV = null, ADVFILE = null;   // v2.28: /api/advisor state (key_set), the file the suggestion panel is open for
  // v2.33: the order the shelf is shown in, remembered per browser; SEED is
  // the shuffle the server dealt, sent back so "Show more" pages the same one.
  const SORTS = { designer: "Designer A-Z", name: "Name A-Z", newest: "Newest first", oldest: "Oldest first", printed: "Most printed", random: "Random" };
  // H21: newest first by default - what you just saved from Orca is the
  // thing the tab's own help text tells you to go find. A remembered choice
  // still wins.
  let SORT = "newest", SEED = 0;
  try { const v = localStorage.getItem("u1.models.sort"); if (v && SORTS[v]) SORT = v; } catch {}
  let RAIL_Q = "", ERR = null, LOADING = false, ALIASES = {};
  // 2.45.1: what the grid and the rail currently show. A poll during a
  // rescan (every 4 s) used to rebuild both from scratch even when nothing
  // in them had changed: every thumbnail re-requested, every chips row back
  // to "…" and refilled, the page flashing and jumping under a scrolling
  // thumb. Now a render that would draw the same thing skips the DOM work.
  let GRID_SIG = "", RAIL_SIG = "";
  const TOP_N = 12;
  // v2.40: print requests from 3MF Explorer. REQ_ONLY toggles the
  // "Requested" filter (server-side, via ?requested=1); requestedTotal comes
  // back on every /api/models answer so the button's count is never stale.
  let REQ_ONLY = false;
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
      // H21 (2.44): the tab is for phones too. Only what launches a program on
      // the Hub computer hides on coarse pointers: Open in Orca, the Orca
      // session strip, the tuned-open row. The \u22ef menu and everything in it
      // works over HTTP and stays.
      "@media (pointer: coarse) { .mdl-act .mdl-open, #mdl-sess { display: none !important; } }",
      // H21: on narrow screens the gcode sidebar folds away while Models is
      // showing, so the cards get the whole width; the Library button in the
      // toolbar brings it back.
      "@media (max-width: 1100px) { body[data-view=\"models\"]:not(.mdl-side-open) .side { display: none !important; } body[data-view=\"models\"]:not(.mdl-side-open) .shell { grid-template-columns: 1fr; } }",
      "#mdl-sidebtn{display:none;} @media (max-width: 1100px) { #mdl-sidebtn{display:inline-flex;} }",
      // v2.42: Open in Orca with the suggested settings - desktop only, like Open in Orca.
      "@media (pointer: coarse) { .mdl-tunerow { display: none !important; } }",
      ".mdl-tunerow{display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px;}",
      ".mdl-tunerow .st{margin:0;}",
      ".mdl-tuned{margin-top:8px; font-size:12.5px; color:var(--ink-dim); line-height:1.5;}",
      ".mdl-tuned b{color:var(--ink);}",
      ".mdl-tuned .skip{color:var(--warn,#f5b316);}",
      ".mdl-wrap{display:grid; grid-template-columns: 220px minmax(0,1fr); gap:14px; margin-top:12px;}",
      ".mdl-rail{background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); padding:10px; align-self:start; position:sticky; top:12px; max-height:calc(100vh - 40px); overflow:auto; display:flex; flex-direction:column; gap:2px;}",
      ".mdl-rail button{display:flex; width:100%; justify-content:space-between; gap:8px; background:transparent; border:none; color:var(--ink-dim); font:inherit; font-size:12.5px; text-align:left; padding:6px 8px; border-radius:var(--r-sm,6px); cursor:pointer;}",
      ".mdl-rail button:hover{background:var(--panel-2,rgba(255,255,255,.04)); color:var(--ink);}",
      ".mdl-rail button.on{background:color-mix(in srgb, var(--signal) 16%, transparent); color:var(--ink); font-weight:600;}",
      // F13c: weight by count - the eye lands on the big designers first
      ".mdl-rail button.w1{opacity:.62;} .mdl-rail button.w2{opacity:.82;} .mdl-rail button.w3{opacity:1;} .mdl-rail button.on{opacity:1;}",
      ".mdl-rail .n{font-family:var(--mono); font-size:10px; color:var(--ink-faint); vertical-align:super;}",
      ".mdl-rail button.on .n{color:var(--ink-dim);}",
      // H21: the typeahead over the whole designer list
      ".mdl-railq{position:relative; margin:4px 0 2px;}",
      ".mdl-railq input{width:100%; font:inherit; font-size:12.5px; color:var(--ink); background:var(--panel-2,#15171c); border:1px solid var(--field); border-radius:var(--r-sm,6px); padding:6px 8px;}",
      ".mdl-raildrop{position:absolute; left:0; right:0; top:100%; z-index:6; max-height:260px; overflow:auto; background:var(--panel); border:1px solid var(--line); border-radius:var(--r-sm,6px); box-shadow:var(--elev); display:none; flex-direction:column; padding:4px;}",
      ".mdl-raildrop.show{display:flex;}",
      ".mdl-railmore{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); padding:4px 8px;}",
      ".mdl-bar{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:10px;}",
      ".mdl-bar input.field{flex:1 1 220px; min-width:0;}",
      // F13g: sort as one segmented control, not a select
      ".mdl-seg{display:inline-flex; border:1px solid var(--line); border-radius:var(--r-pill,999px); overflow:hidden; flex:0 0 auto;}",
      ".mdl-seg button{background:transparent; border:none; border-right:1px solid var(--line); color:var(--ink-dim); font:inherit; font-size:11.5px; padding:5px 10px; cursor:pointer; white-space:nowrap;}",
      ".mdl-seg button:last-child{border-right:none;}",
      ".mdl-seg button.on{background:color-mix(in srgb, var(--signal) 18%, transparent); color:var(--ink); font-weight:600;}",
      ".mdl-tools{display:inline-flex; gap:8px; align-items:center;}",
      // 2.44.1: the base rule must come BEFORE the media rule - same specificity, so the
      // later one wins, and with them the other way round the button never showed.
      "#mdl-toolsbtn{display:none;}",
      "@media (max-width: 880px) { .mdl-tools{display:none;} .mdl-bar.tools .mdl-tools{display:inline-flex; flex-basis:100%;} #mdl-toolsbtn{display:inline-flex;} }",
      ".mdl-sub .prints{color:var(--ink); font-weight:600;}",
      ".mdl-grid{display:grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap:10px;}",
      "@media (max-width: 480px) { .mdl-grid{grid-template-columns: repeat(2, minmax(0,1fr)); gap:8px;} }",
      // F13d: dividers on the newest sort
      ".mdl-div{grid-column:1/-1; display:flex; align-items:center; gap:10px; font-family:var(--mono); font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-faint); margin-top:6px;}",
      ".mdl-div::after{content:''; flex:1; height:1px; background:var(--line);}",
      // F13a: a 3px palette strip from the project's own filament colors
      ".mdl-card{background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); overflow:hidden; display:flex; flex-direction:column; min-width:0; transition: transform var(--dur,.18s) var(--ease,ease), box-shadow var(--dur,.18s) var(--ease,ease), border-color var(--dur,.18s) var(--ease,ease);}",
      ".mdl-card::before{content:''; display:block; height:3px; background:var(--pal, var(--line));}",
      "@media (hover: hover) { .mdl-card:hover{transform:translateY(-2px); box-shadow:var(--elev-2, var(--elev)); border-color:color-mix(in srgb, var(--ink-faint) 40%, var(--line));} }",
      ".mdl-card:focus-within{border-color:color-mix(in srgb, var(--signal) 50%, var(--line));}",
      // F13b: the thumb is the card - a quiet vignette, pills in the corner
      ".mdl-thumb{aspect-ratio:1/1; background:radial-gradient(70% 70% at 50% 45%, var(--panel-2,#15171c), var(--chassis,#0D0F14)); display:flex; align-items:center; justify-content:center; overflow:hidden; position:relative;}",
      ".mdl-thumb img{width:100%; height:100%; object-fit:contain; display:block;}",
      ".mdl-thumb .nothumb{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint);}",
      ".mdl-pills{position:absolute; left:8px; bottom:8px; display:flex; gap:4px; flex-wrap:wrap; pointer-events:none;}",
      ".mdl-pill{font-family:var(--mono); font-size:9.5px; letter-spacing:.04em; padding:2px 7px; border-radius:var(--r-pill,999px); background:color-mix(in srgb, var(--chassis,#0D0F14) 78%, transparent); border:1px solid color-mix(in srgb, var(--signal) 55%, transparent); color:var(--signal); backdrop-filter:blur(4px);}",
      ".mdl-pill.ok{border-color:color-mix(in srgb, var(--ok,#3DD68C) 55%, transparent); color:var(--ok,#3DD68C);}",
      // F13e: skeletons while loading, an honest empty state
      ".mdl-skel{background:var(--panel); border:1px solid var(--line); border-radius:var(--r-lg,12px); overflow:hidden;}",
      ".mdl-skel .t{aspect-ratio:1/1; background:var(--panel-2,#15171c);}",
      ".mdl-skel .l{height:10px; margin:10px; border-radius:4px; background:var(--panel-2,#15171c);}",
      ".mdl-skel .l.s{width:55%;}",
      ".mdl-skel .t, .mdl-skel .l{position:relative; overflow:hidden;}",
      ".mdl-skel .t::after, .mdl-skel .l::after{content:''; position:absolute; inset:0; transform:translateX(-100%); background:linear-gradient(90deg, transparent, rgba(255,255,255,.05), transparent); animation:mdlsheen 1.1s var(--ease,ease) infinite;}",
      "@keyframes mdlsheen{to{transform:translateX(100%);}}",
      ".mdl-grid.stale{opacity:.55; pointer-events:none;}",
      ".mdl-err{display:flex; gap:10px; align-items:center; flex-wrap:wrap; background:var(--panel); border:1px solid color-mix(in srgb, var(--bad,#e5484d) 50%, var(--line)); border-radius:var(--r-lg,12px); padding:10px 13px; margin-bottom:10px; font-size:13px; color:var(--ink);}",
      ".mdl-err:empty{display:none;}",
      ".mdl-empty .btn{margin-top:10px;}",
      ".mdl-prog{font-family:var(--mono); font-size:11px; color:var(--ink-faint);}",
      ".mdl-body{padding:9px 10px 10px; display:flex; flex-direction:column; gap:5px; min-width:0;}",
      ".mdl-name{font-size:13px; font-weight:600; color:var(--ink); line-height:1.3; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;}",
      ".mdl-sub{font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}",
      ".mdl-chips{display:flex; gap:4px; align-items:center; height:16px; min-height:16px; flex-wrap:nowrap; overflow:hidden; white-space:nowrap;}",
      ".mdl-chip{width:14px; height:14px; border-radius:4px; border:1px solid rgba(255,255,255,.18); flex:none;}",
      ".mdl-chips .k{font-family:var(--mono); font-size:10px; color:var(--ink-faint); overflow:hidden; text-overflow:ellipsis; min-width:0;}",
      // F13f: one action row - the primary and the \u22ef menu; the rest behind it
      ".mdl-act{display:flex; gap:6px; margin-top:2px; flex-wrap:wrap; align-items:center;}",
      ".mdl-act .btn{font-size:11.5px; padding:4px 9px;}",
      ".mdl-act .mdl-convert-primary{display:none;}",
      "@media (pointer: coarse) { .mdl-act .mdl-convert-primary{display:inline-flex;} }",
      // v2.30: the second row of card actions (rename to the convention,
      // attributes, delete) and the inline editor / confirm they open. No
      // browser dialogs: a confirm is a second click on the same card.
      ".mdl-act2{display:none; gap:6px; margin-top:-1px; flex-wrap:wrap;}",
      ".mdl-card.more .mdl-act2{display:flex;}",
      ".mdl-card{position:relative;}",
      ".mdl-card .mdl-more{position:absolute; top:11px; right:8px; z-index:2; padding:2px 8px; font-size:13px; line-height:1.2; letter-spacing:1px; background:color-mix(in srgb, var(--panel) 82%, transparent); opacity:.9; min-width:34px; min-height:30px;}",
      ".mdl-card:hover .mdl-more, .mdl-card.more .mdl-more, .mdl-card .mdl-more:focus-visible{opacity:1;}",
      ".mdl-card.more .mdl-more{color:var(--ink); border-color:var(--ink-faint);}",
      ".mdl-sub .grp{font-size:9.5px; padding:0 5px; border:1px solid var(--line); border-radius:4px; color:var(--ink-dim);}",
      ".mdl-act2 .btn{font-size:11px; padding:3px 8px; color:var(--ink-dim);}",
      ".mdl-act2 .btn.danger{color:var(--bad,#e5484d); border-color:color-mix(in srgb, var(--bad,#e5484d) 45%, var(--line));}",
      ".mdl-edit{display:none; flex-direction:column; gap:6px; margin-top:4px; padding:8px; border:1px solid color-mix(in srgb, var(--signal) 40%, var(--line)); border-radius:var(--r-sm,6px); background:var(--panel-2);}",
      ".mdl-edit.show{display:flex;}",
      ".mdl-edit label{font-family:var(--mono); font-size:10.5px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-faint);}",
      ".mdl-edit input{font:inherit; font-size:12.5px; color:var(--ink); background:var(--panel); border:1px solid var(--field); border-radius:var(--r-sm,6px); padding:5px 7px; width:100%;}",
      ".mdl-edit .tgt{font-family:var(--mono); font-size:10.5px; color:var(--ink-dim); word-break:break-all; line-height:1.4;}",
      ".mdl-edit .tgt b{color:var(--ink); font-weight:600;}",
      ".mdl-edit .row{display:flex; gap:6px; flex-wrap:wrap; align-items:center;}",
      ".mdl-edit .msg{font-size:11.5px; color:var(--ink-dim);}",
      ".mdl-edit .msg.err{color:var(--bad,#e5484d);}",
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
      // H21: under 1100px the rail is one row - the active chip, the top
      // designers that fit, and the typeahead - never the whole list.
      "@media (max-width: 1100px){ .mdl-wrap{grid-template-columns: 1fr;} .mdl-rail{position:static; max-height:none; flex-direction:row; flex-wrap:wrap; gap:4px; align-items:center;} .mdl-rail button{width:auto;} .mdl-railq{flex:1 1 160px; margin:0;} .mdl-rail .mdl-railtop{display:none;} .mdl-rail .mdl-railtop.on{display:flex;} }",
      // v2.40: print requests from 3MF Explorer - the "Requested" badge on
      // a card, and the inline gcode-link tool.
      ".mdl-reqhold:empty{display:none;}",
      ".mdl-req{display:inline-flex; align-items:center; gap:2px; font-family:var(--mono); font-size:10.5px; padding:2px 7px; border-radius:var(--r-pill,999px); border:1px solid color-mix(in srgb, var(--signal) 50%, var(--line)); color:var(--signal); width:fit-content;}",
      ".mdl-req.done{border-color:color-mix(in srgb, var(--ok,#3DD68C) 50%, var(--line)); color:var(--ok,#3DD68C);}",
      ".mdl-req .btn{font-size:9.5px !important; padding:1px 6px !important; color:inherit; border-color:currentColor;}",
      ".mdl-link-row{display:flex; justify-content:space-between; align-items:center; gap:6px; font-family:var(--mono); font-size:11px; color:var(--ink-dim);}",
      ".mdl-link-row .unv{color:var(--warn,#F5A524);}"
    ].join("\n");
    document.head.appendChild(s);
  }

  // F13g: the sort is a segmented control. Name and Oldest stay reachable
  // through a remembered choice but are not pills - five is the most a phone
  // row takes.
  const SORT_PILLS = ["newest", "designer", "printed", "random"];
  function sortSeg() {
    const keys = SORT_PILLS.includes(SORT) ? SORT_PILLS : SORT_PILLS.concat([SORT]);
    return '<div class="mdl-seg" id="mdl-sort" role="group" aria-label="Order">' +
      keys.map(k => '<button type="button" data-sort="' + k + '" class="' + (k === SORT ? "on" : "") + '">' + esc(SORTS[k].replace(" first", "").replace(" A-Z", "")) + "</button>").join("") + "</div>";
  }
  function setSort(k) {
    SORT = SORTS[k] ? k : "newest";
    try { localStorage.setItem("u1.models.sort", SORT); } catch {}
    const seg = EL.querySelector("#mdl-sort"); if (seg) seg.outerHTML = sortSeg();
    bindSort();
    EL.querySelector("#mdl-shuffle").style.display = SORT === "random" ? "" : "none";
    SEED = 0; OFFSET = 0; load();
  }
  function bindSort() { EL.querySelectorAll("#mdl-sort [data-sort]").forEach(b => b.addEventListener("click", () => setSort(b.dataset.sort))); }

  function mount(el) {
    EL = el; style();
    readHash();                                     // H22: a shared link restores filter, designer, sort
    el.innerHTML =
      '<div class="sechead"><h2>Models</h2><span class="count" id="mdl-count"></span></div>' +
      '<p class="subnote">3MF projects you have not sliced yet. Open one in Orca, save the gcode, and it lands in the library.</p>' +
      '<div id="mdl-sess"></div>' +
      '<div class="mdl-err" id="mdl-err"></div>' +
      '<div class="mdl-adv" id="mdl-adv"></div>' +
      '<div class="mdl-cfg" id="mdl-cfg"></div>' +
      '<div class="mdl-bar" id="mdl-bar">' +
      '<input class="field" id="mdl-q" value="' + esc(Q) + '" placeholder="Filter models (* ? -word)" title="Plain text matches anywhere in designer/model/file. * and ? are wildcards. -word excludes.">' +
      sortSeg() +
      '<button class="btn ghost" id="mdl-shuffle" title="Deal a new random order"' + (SORT === "random" ? "" : ' style="display:none"') + '>Shuffle</button>' +
      '<button class="btn ghost" id="mdl-req" title="Only 3MFs marked for print in 3MF Explorer">Requested</button>' +
      '<button class="btn ghost" id="mdl-sidebtn" title="Show or hide the gcode library">Library</button>' +
      '<button class="btn ghost" id="mdl-toolsbtn" title="Rescan, folder settings" aria-label="More tools">\u22ef</button>' +
      '<span class="mdl-tools">' +
      '<button class="btn ghost" id="mdl-rescan" title="Walk the folder again now">Rescan</button>' +
      '<button class="btn ghost" id="mdl-cfgbtn">Folder</button>' +
      '</span>' +
      '</div>' +
      '<div class="mdl-wrap"><div class="mdl-rail" id="mdl-rail"></div><div><div class="mdl-grid" id="mdl-grid"></div><div class="mdl-foot" id="mdl-foot"></div></div></div>';
    let t = 0;
    el.querySelector("#mdl-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { Q = e.target.value.trim(); OFFSET = 0; load(); }, 220); });
    el.querySelector("#mdl-rescan").addEventListener("click", () => { OFFSET = 0; load(true); });
    bindSort();
    el.querySelector("#mdl-shuffle").addEventListener("click", () => { SEED = 0; OFFSET = 0; load(); });
    el.querySelector("#mdl-req").addEventListener("click", () => { REQ_ONLY = !REQ_ONLY; OFFSET = 0; load(); });
    el.querySelector("#mdl-cfgbtn").addEventListener("click", () => { el.querySelector("#mdl-cfg").classList.toggle("show"); });
    el.querySelector("#mdl-toolsbtn").addEventListener("click", () => { el.querySelector("#mdl-bar").classList.toggle("tools"); });
    el.querySelector("#mdl-sidebtn").addEventListener("click", () => { document.body.classList.toggle("mdl-side-open"); });
    el.querySelector("#mdl-err").addEventListener("click", e => { if (e.target.id === "mdl-retry") { OFFSET = 0; load(); } });
    el.querySelector("#mdl-rail").addEventListener("click", e => {
      const b = e.target.closest("button[data-c]"); if (!b) return;
      CREATOR = b.dataset.c; OFFSET = 0; RAIL_Q = ""; load();
    });
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
    if (box.querySelector("#mdl-folder") && [box.querySelector("#mdl-folder"), box.querySelector("#mdl-orca"), box.querySelector("#mdl-u1t")].includes(document.activeElement)) return;
    const folder = DATA && DATA.folder ? DATA.folder : "";
    const orca = DATA && DATA.orcaExe ? DATA.orcaExe : (SETTINGS && SETTINGS.orcaExe ? SETTINGS.orcaExe : "");
    box.innerHTML =
      '<label>3MF folder <span class="hint">designer folders inside it become the list on the left; up to four levels deep; folders starting with _ are skipped</span></label>' +
      '<input class="field" id="mdl-folder" placeholder="' + (folder ? "" : "loading…") + '" value="' + esc(folder) + '">' +
      '<label>Snapmaker Orca <span class="hint">the program the Open button launches, on this computer</span></label>' +
      '<input class="field" id="mdl-orca" placeholder="C:\\Program Files\\Snapmaker_Orca\\snapmaker-orca.exe" value="' + esc(orca) + '">' +
      '<label>U1 template <span class="hint">for Convert to U1: a project saved in Snapmaker Orca with the U1 and your usual filaments; blank uses u1_template.3mf at the top of the folder' + (DATA && DATA.u1_template ? " (found: " + esc(DATA.u1_template) + ")" : " (none found yet)") + '</span></label>' +
      '<input class="field" id="mdl-u1t" placeholder="' + esc(folder ? folder.replace(/[\\/]+$/, "") + "\\u1_template.3mf" : "u1_template.3mf") + '" value="' + esc(DATA && DATA.u1_template_set || "") + '">' +
      '<div class="row" style="margin-top:8px; gap:8px"><button class="btn primary" id="mdl-save" style="font-size:12px; padding:5px 12px">Save</button><span class="pstatus" id="mdl-cfgmsg"></span></div>' +
      // H22 (2.44): designer aliases - folder name = display name, one per line.
      '<label>Designer names <span class="hint">the designer list comes from the top folders; rename or merge them here without touching a file: <code>folder name = Display Name</code>, one per line. Folders that cannot be a designer (numbers, temperatures, one or two letters) are grouped as (unsorted).</span></label>' +
      '<textarea class="field" id="mdl-aliases" rows="4" spellcheck="false" style="width:100%; font-family:var(--mono); font-size:12px" placeholder="220\u00b0c = Temperature towers\nBambu Lab = Bambu">' + esc(Object.entries(ALIASES || {}).map(([k, v]) => k + " = " + v).join("\n")) + '</textarea>' +
      '<div class="row" style="margin-top:6px; gap:8px"><button class="btn ghost" id="mdl-aliases-save" style="font-size:12px; padding:5px 12px">Save names</button><span class="pstatus" id="mdl-aliasmsg"></span></div>' +
      // v2.40: pairing with 3MF Explorer (its "Mark for print" lands in Requested here).
      '<label>3MF Explorer <span class="hint">to send "Mark for print" here, put this Hub\'s address and token in 3MF Explorer\'s config.json (hub.url, hub.token) and restart it</span></label>' +
      '<div class="row" style="gap:8px; flex-wrap:wrap; align-items:center"><code id="mdl-pair" style="font-size:11.5px; word-break:break-all">…</code><button class="btn ghost" id="mdl-paircopy" style="font-size:11px; padding:3px 8px">Copy token</button></div>';
    jget("/api/models/pairing").then(p => {
      const el = box.querySelector("#mdl-pair"); if (!el) return;
      el.textContent = p && p.token ? "url " + p.url + "  ·  token " + p.token : "no token (restart the Hub once)";
      const b = box.querySelector("#mdl-paircopy");
      if (b && p && p.token) b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(p.token); b.textContent = "Copied"; } catch { b.textContent = "Select and copy it"; } });
    });
    box.querySelector("#mdl-aliases-save").addEventListener("click", async () => {
      const m = box.querySelector("#mdl-aliasmsg");
      const aliases = {};
      for (const line of box.querySelector("#mdl-aliases").value.split(/\r?\n/)) {
        const i = line.indexOf("="); if (i < 1) continue;
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k && v) aliases[k] = v;
      }
      const r = await jpost("/api/models/aliases", { aliases });
      if (!r.ok) { m.className = "pstatus err"; m.textContent = r.d.error || "Could not save"; return; }
      ALIASES = r.d.aliases || {};
      m.className = "pstatus ok"; m.textContent = Object.keys(ALIASES).length + " name" + (Object.keys(ALIASES).length === 1 ? "" : "s") + " saved.";
      CREATOR = ""; OFFSET = 0; load();
    });
    box.querySelector("#mdl-save").addEventListener("click", async () => {
      const fv = box.querySelector("#mdl-folder").value.trim();
      if (!fv) { const m = box.querySelector("#mdl-cfgmsg"); m.className = "pstatus err"; m.textContent = "Enter the folder path (it was left blank)."; return; }
      const r = await jpost("/api/models/settings", { folder: fv, orcaExe: box.querySelector("#mdl-orca").value, u1Template: box.querySelector("#mdl-u1t").value });
      const m = box.querySelector("#mdl-cfgmsg");
      if (!r.ok) { m.className = "pstatus err"; m.textContent = r.d.error || "Could not save"; return; }
      SETTINGS = r.d;
      m.className = "pstatus " + (r.d.folder_found ? "ok" : "err");
      m.textContent = (r.d.folder_found ? "Folder found. " : "Folder not found: " + r.d.folder + ". ") + (r.d.orca_found ? "Orca found. " : "Orca not found at " + r.d.orcaExe + ". ") + (r.d.u1_template ? "U1 template found." : "No U1 template yet.");
      CREATOR = ""; OFFSET = 0;
      setTimeout(() => load(), 800);
    });
  }

  // H22: the view's state rides in the URL hash (#models?q=..&c=..&s=..&r=1)
  // so a refresh or a shared link lands on the same shelf.
  function readHash() {
    try {
      const h = decodeURIComponent(location.hash.replace(/^#/, ""));
      if (!/^models\?/i.test(h)) return;
      const ps = new URLSearchParams(h.slice(h.indexOf("?") + 1));
      Q = ps.get("q") || ""; CREATOR = ps.get("c") || ""; REQ_ONLY = ps.get("r") === "1";
      const sv = ps.get("s"); if (sv && SORTS[sv]) SORT = sv;
    } catch {}
  }
  function writeHash() {
    if (document.body.dataset.view !== "models") return;
    const ps = new URLSearchParams();
    if (Q) ps.set("q", Q); if (CREATOR) ps.set("c", CREATOR); if (SORT !== "newest") ps.set("s", SORT); if (REQ_ONLY) ps.set("r", "1");
    const h = "#models" + (ps.toString() ? "?" + ps.toString() : "");
    if (location.hash !== h) { try { history.replaceState(null, "", h); } catch {} }
  }
  function skeletons(n) {
    return Array.from({ length: n }, () => '<div class="mdl-skel" aria-hidden="true"><div class="t"></div><div class="l"></div><div class="l s"></div></div>').join("");
  }
  // quiet: a background poll while a walk runs. It must never dim the grid or
  // take the pointer away - the person may be scrolling it (2.45.2).
  async function load(refresh, append, quiet) {
    if (BUSY) return; BUSY = true; LOADING = true;
    const grid = EL.querySelector("#mdl-grid");
    // F13e: a fresh page shows skeletons, a paging call keeps the cards and dims nothing.
    if (!append && !(DATA && DATA.items && DATA.items.length)) grid.innerHTML = skeletons(12);
    else if (!append && !quiet) grid.classList.add("stale");
    try {
      const u = "/api/models?limit=60&offset=" + OFFSET + (Q ? "&q=" + encodeURIComponent(Q) : "") + (CREATOR ? "&creator=" + encodeURIComponent(CREATOR) : "") + (refresh ? "&refresh=1" : "")
        + (SORT !== "designer" ? "&sort=" + SORT : "") + (SORT === "random" && SEED ? "&seed=" + SEED : "") + (REQ_ONLY ? "&requested=1" : "");
      let d = null, errMsg = null;
      try {
        const r = await fetch(u);
        if (r.ok) d = await r.json();
        else { const j = await r.json().catch(() => ({})); errMsg = j.error || ("HTTP " + r.status); }
      } catch (e) { errMsg = e.message || "network error"; }
      // H22: a failed load says so and offers a retry; the old grid stays, dimmed.
      const eb = EL.querySelector("#mdl-err");
      if (!d) {
        ERR = errMsg;
        eb.innerHTML = "Could not reach the Hub (" + esc(errMsg) + "). The list below may be out of date. " +
          '<button class="btn ghost" id="mdl-retry" style="font-size:11.5px; padding:3px 9px">Retry</button>';
        if (!(DATA && DATA.items && DATA.items.length)) grid.innerHTML = '<div class="mdl-empty" style="grid-column:1/-1">Nothing to show until the Hub answers.</div>';
        return;
      }
      ERR = null; eb.innerHTML = "";
      if (d.sort === "random" && d.seed) SEED = d.seed;
      if (d.aliases) ALIASES = d.aliases;
      const prev = DATA; DATA = d;
      SETTINGS = { ...(SETTINGS || {}), orcaExe: d.orcaExe || (SETTINGS && SETTINGS.orcaExe) || null, orca_found: d.orca_found };
      render(append && prev ? prev.items : null);
      if (!prev || prev.folder !== d.folder) renderCfg();
      writeHash();
      // While a scan is running and there is nothing to show yet, poll.
      if ((d.refreshing || d.scanning) && !d.items.length) setTimeout(() => { if (!BUSY) load(false, false, true); }, 2500);
      // H22: a walk in progress keeps the count line moving while the list stays usable.
      else if (d.refreshing) setTimeout(() => { if (!BUSY) load(false, false, true); }, 4000);
    } finally { BUSY = false; LOADING = false; grid.classList.remove("stale"); }
  }

  // H21: the rail. "All designers", the top TOP_N by count (weighted, F13c),
  // then a typeahead over everyone else. Never the whole list as buttons.
  function railHtml(d) {
    const all = (d.creators || []).slice();
    const byCount = all.slice().sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
    const top = byCount.slice(0, TOP_N);
    const max = top.length ? top[0].count : 1;
    const weight = c => c >= max * 0.5 ? "w3" : c >= max * 0.1 ? "w2" : "w1";
    const chip = (c, extra) => { const v = c.name || "__none__"; const on = CREATOR === v; return '<button type="button" class="mdl-railtop ' + (on ? "on " : "") + weight(c.count) + (extra || "") + '" data-c="' + esc(v) + '"><span>' + esc(c.name || "(no folder)") + '</span><span class="n">' + c.count + "</span></button>"; };
    let h = '<button type="button" class="mdl-railtop ' + (CREATOR ? "" : "on") + ' w3" data-c=""><span>All designers</span><span class="n">' + d.total_all + "</span></button>";
    const topNames = new Set(top.map(c => c.name || "__none__"));
    h += top.map(c => chip(c)).join("");
    // the active designer always shows, even when it is not in the top N
    if (CREATOR && !topNames.has(CREATOR)) { const c = all.find(x => (x.name || "__none__") === CREATOR); if (c) h += chip(c, " on"); }
    const rest = all.length - top.length;
    h += '<div class="mdl-railq"><input type="search" id="mdl-railq" placeholder="' + (rest > 0 ? "Find a designer (" + all.length + ")" : "Find a designer") + '" autocomplete="off" value="' + esc(RAIL_Q) + '"><div class="mdl-raildrop" id="mdl-raildrop"></div></div>';
    return h;
  }
  function railDrop() {
    const box = EL.querySelector("#mdl-raildrop"); if (!box) return;
    const q = RAIL_Q.trim().toLowerCase();
    if (!q) { box.className = "mdl-raildrop"; box.innerHTML = ""; return; }
    const all = (DATA && DATA.creators) || [];
    const hits = all.filter(c => String(c.name || "(no folder)").toLowerCase().includes(q)).sort((a, b) => b.count - a.count).slice(0, 30);
    box.innerHTML = hits.map(c => '<button type="button" data-c="' + esc(c.name || "__none__") + '"><span>' + esc(c.name || "(no folder)") + '</span><span class="n">' + c.count + "</span></button>").join("") +
      (hits.length ? "" : '<div class="mdl-railmore">no designer matches</div>') + (hits.length === 30 ? '<div class="mdl-railmore">keep typing to narrow it</div>' : "");
    box.className = "mdl-raildrop show";
  }
  // F13d: dividers on the newest sort. Pure presentation, computed from mtime.
  function dividerFor(it, prevKey) {
    const age = Date.now() - (it.mtime || 0), DAY = 86400000;
    const key = age < DAY ? "Today" : age < 7 * DAY ? "This week" : age < 31 * DAY ? "This month" : "Earlier";
    return key === prevKey ? null : key;
  }
  function render(prependItems) {
    const d = DATA;
    // 2.44.1: a walk of this share spends its first 15 s in folders that hold no
    // 3MF, so a files-only count sat at 0 and read as hung. Count folders too:
    // progress shows the work done, not only the result.
    const sp = d.scan_progress || {};
    const prog = d.refreshing && d.scan_progress ? " \u00b7 rescanning\u2026 " + (sp.dirs || 0) + " folder" + (sp.dirs === 1 ? "" : "s") + ", " + (sp.walked || 0) + " file" + (sp.walked === 1 ? "" : "s") + (sp.last_total ? " of about " + sp.last_total : "") + " so far" : (d.refreshing ? " \u00b7 rescanning\u2026" : "");
    EL.querySelector("#mdl-count").textContent = d.missing ? "folder not found"
      : (d.scanning && !d.total_all) ? ("scanning the folder\u2026" + (d.scan_progress ? " " + (sp.dirs || 0) + " folders, " + (sp.walked || 0) + " files so far" : ""))
      : (d.total_all + " file" + (d.total_all === 1 ? "" : "s") + prog + (d.unreachable ? " \u00b7 folder not reachable right now, showing the last scan" : ""));
    // v2.40: the count on the toggle is always the TRUE total (from the
    // unfiltered `all` list server-side), so it stays right even while the
    // filter itself, or a search/creator filter, is narrowing what's shown.
    const reqBtn = EL.querySelector("#mdl-req");
    if (reqBtn) {
      reqBtn.className = "btn " + (REQ_ONLY ? "primary" : "ghost");
      reqBtn.textContent = "Requested" + (d.requested_total ? " (" + d.requested_total + ")" : "");
    }
    const rail = EL.querySelector("#mdl-rail");
    const railSig = CREATOR + "|" + d.total_all + "|" + (d.creators || []).map(c => (c.name || "") + ":" + c.count).join(",");
    if (railSig !== RAIL_SIG || !rail.querySelector("#mdl-railq")) {
      RAIL_SIG = railSig;
      const hadFocus = document.activeElement && document.activeElement.id === "mdl-railq";
      rail.innerHTML = railHtml(d);
      const rq = rail.querySelector("#mdl-railq");
      rq.addEventListener("input", () => { RAIL_Q = rq.value; railDrop(); });
      rq.addEventListener("focus", railDrop);
      rq.addEventListener("keydown", e => { if (e.key === "Escape") { RAIL_Q = ""; rq.value = ""; railDrop(); } if (e.key === "Enter") { const first = rail.querySelector("#mdl-raildrop button"); if (first) first.click(); } });
      document.addEventListener("click", e => { if (!e.target.closest(".mdl-railq")) { const b = rail.querySelector("#mdl-raildrop"); if (b) b.className = "mdl-raildrop"; } }, { once: true, capture: true });
      if (hadFocus) rq.focus();
    }
    const grid = EL.querySelector("#mdl-grid");
    const items = (prependItems || []).concat(d.items);
    // Everything a card draws from its item, plus the view's own switches.
    const gridSig = (d.missing ? "missing" : "") + "|" + SORT + "|" + Q + "|" + REQ_ONLY + "|" + CREATOR + "|" + (d.orca_found === false) + "|" +
      items.map(it => it.rel + ":" + (it.mtime || 0) + ":" + (it.prints || 0) + ":" + (it.conventional ? 1 : 0) + ":" + (it.requested ? it.requested.status + "/" + (it.requested.pieces || 0) : "")).join(";");
    const sameGrid = gridSig === GRID_SIG && items.length > 0 && !d.missing;
    GRID_SIG = gridSig;
    const sidebtn = EL.querySelector("#mdl-sidebtn"); if (sidebtn) sidebtn.classList.toggle("primary", document.body.classList.contains("mdl-side-open"));
    if (d.missing) {
      grid.innerHTML = '<div class="mdl-empty" style="grid-column:1/-1">No folder at <code>' + esc(d.folder) + '</code>.<br><button class="btn primary" data-showcfg="1">Point the Hub at your 3MF folder</button></div>';
    } else if (!items.length) {
      // F13e: one line and one action, never a paragraph in the grid
      let msg, act = "";
      if (REQ_ONLY) { msg = "Nothing marked for print yet."; act = '<button class="btn ghost" data-clearfilter="req">Show everything</button>'; }
      else if (d.total_all && (Q || CREATOR)) { msg = "Nothing matches" + (Q ? " \u201c" + esc(Q) + "\u201d" : "") + (CREATOR ? " for " + esc(CREATOR === "__none__" ? "(no folder)" : CREATOR) : "") + "."; act = '<button class="btn ghost" data-clearfilter="all">Clear the filter</button>'; }
      else if (d.refreshing || d.scanning) { if (!grid.querySelector(".mdl-skel")) grid.innerHTML = skeletons(12); return; }
      else { msg = "No 3MF files under <code>" + esc(d.folder) + "</code>."; act = '<button class="btn ghost" data-showcfg="1">Check the folder</button>'; }
      grid.innerHTML = '<div class="mdl-empty" style="grid-column:1/-1">' + msg + "<br>" + act + "</div>";
    } else if (sameGrid) {
      // same cards in the same order: leave the DOM, the thumbnails and the
      // filled chips rows alone (only the count line above moved)
    } else {
      let html = "", prevKey = null;
      for (const it of items) {
        if (SORT === "newest" && !Q && !REQ_ONLY) { const k = dividerFor(it, prevKey); if (k) { html += '<div class="mdl-div">' + k + "</div>"; prevKey = k; } }
        html += card(it);
      }
      grid.innerHTML = html;
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
    // F13b: printed-count and the conventional mark are pills on the thumb,
    // not words in the gray line. F13f: one primary + the menu; everything
    // else lives behind it. On touch the primary is Convert to U1 (Open in
    // Orca only works at the console).
    const pills = (it.prints ? '<span class="mdl-pill" title="completed prints of gcode sliced from this file, from the printers\' own job history">printed ' + it.prints + "\u00d7</span>" : "") +
      (it.conventional ? '<span class="mdl-pill ok" title="filed the way the convention wants it">\u2713 filed</span>' : "");
    return '<div class="mdl-card' + (it.conventional ? " conv" : "") + '" data-rel="' + esc(it.rel) + '">' +
      '<button class="btn ghost mdl-more" data-more="' + esc(it.rel) + '" title="Settings, convert, link, rename, attributes, delete" aria-label="More">\u22ef</button>' +
      '<div class="mdl-thumb"><img loading="lazy" src="' + q + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'nothumb\',textContent:\'no preview in file\'}))">' + (pills ? '<div class="mdl-pills">' + pills + "</div>" : "") + '</div>' +
      '<div class="mdl-body">' +
      '<div class="mdl-name" title="' + esc(it.rel) + '">' + esc(it.name) + "</div>" +
      '<div class="mdl-sub" title="' + esc(it.rel) + '">' + (it.group ? '<span class="grp" title="format folder">' + esc(it.group) + "</span> " : "") + esc(it.creator || "") + (it.model && it.model !== it.name ? " \u00b7 " + esc(it.model) : "") + " \u00b7 " + mb(it.size) + "</div>" +
      '<div class="mdl-reqhold">' + reqBadge(it) + '</div>' +
      '<div class="mdl-chips" data-info="' + esc(it.rel) + '"><span class="k">\u2026</span></div>' +
      '<div class="mdl-act"><button class="btn primary mdl-open" data-open="' + esc(it.rel) + '"' + (DATA && DATA.orca_found === false ? ' title="Snapmaker Orca not found - set its path under Folder"' : "") + '>Open in Orca</button>' +
      '<button class="btn primary mdl-convert-primary" data-convert="' + esc(it.rel) + '" title="Write a copy for the Snapmaker U1 beside this file">Convert to U1</button>' +
      '</div>' +
      '<div class="mdl-act2">' +
      (window.HUB_FEATURES && window.HUB_FEATURES.advisor === false ? "" : '<button class="btn ghost" data-suggest="' + esc(it.rel) + '" title="Have Claude read this file\'s geometry and the designer\'s profile and suggest the slicer settings for your printer">Suggest settings</button>') +
      '<button class="btn ghost" data-convert="' + esc(it.rel) + '" title="Write a copy for the Snapmaker U1 beside this file, keeping the designer\'s prime tower, walls, infill and supports">Convert to U1</button>' +
      '<button class="btn ghost" data-rename="' + esc(it.rel) + '" title="' + (it.conventional ? "Already filed as Designer\\Name\\Designer - Name.3mf" : "Move to Designer\\Name\\Designer - Name.3mf") + '"' + (it.conventional ? " disabled" : "") + '>Rename</button>' +
      '<button class="btn ghost" data-attrs="' + esc(it.rel) + '" title="Set or change the designer and name">Attributes</button>' +
      '<button class="btn ghost" data-link="' + esc(it.rel) + '" title="Link this to one or more gcode files by hand - for names that don\'t fit the title - designer x&lt;N&gt; convention, or a multi-part model">Link gcode</button>' +
      '<button class="btn ghost danger" data-del="' + esc(it.rel) + '" title="Delete this file from the folder">Delete</button>' +
      '</div>' +
      '<div class="mdl-edit" data-edit="' + esc(it.rel) + '"></div>' +
      "</div></div>";
  }

  // v2.40: the badge for a print request from 3MF Explorer. Rendered into its
  // own holder div so clearing it never disturbs the info chips beside it
  // (those are filled once, lazily, by IntersectionObserver - see lazyInfo).
  function reqBadge(it) {
    if (!it.requested) return "";
    const done = it.requested.status === "dispatched";
    const label = done ? "✓ queued" + (it.requested.pieces ? " · " + it.requested.pieces + " pcs" : "") : "requested";
    const title = done
      ? "Auto-dispatched to " + esc(it.requested.gcode || "a gcode") + (it.requested.job_id ? " (job " + esc(it.requested.job_id) + ")" : "")
      : "Marked for print in 3MF Explorer - no matching gcode yet";
    return '<div class="mdl-req' + (done ? " done" : "") + '" title="' + title + '">' + label +
      '<button class="btn ghost" data-clearreq="' + esc(it.rel) + '" title="Clear this request (does not touch any gcode link or queued job)">clear</button></div>';
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
      c.querySelector(".mdl-sub").textContent = (it.group ? it.group + " \u00b7 " : "") + (it.creator || "") + (it.model && it.model !== it.name ? " \u00b7 " + it.model : "") + " \u00b7 " + mb(it.size);
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

  // ---- v2.40: the manual gcode <-> 3MF link tool, and the print-request badge -
  // One gcode at a time (POST /api/models/link), since a multi-part model
  // needs several links pointed at the same 3MF; the panel lists what's
  // already linked here with an Unlink next to each, and a picker for one
  // more. "unverified" means the auto-watcher's name match didn't confirm it
  // - still trusted, just flagged, until re-linked by hand or by a cleaner name.
  async function askLink(rel) {
    const box = editBox(rel); if (!box) return;
    box.className = "mdl-edit show";
    box.innerHTML = '<div class="msg">loading gcode files…</div>';
    const slug = typeSlug();
    const d = await jget("/api/models/gcodes?type=" + encodeURIComponent(slug));
    if (!d || !d.folder) {
      box.innerHTML = '<div class="msg err">Could not read the gcode folder' + (d ? " (" + esc(d.type) + ")" : "") + ".</div><div class=\"row\"><button class=\"btn ghost\" data-cancel=\"" + esc(rel) + '" style="font-size:11px; padding:3px 8px">Close</button></div>';
      return;
    }
    renderLinkPanel(rel, d);
  }
  function renderLinkPanel(rel, d) {
    const box = editBox(rel); if (!box) return;
    const mine = d.files.filter(f => f.linked === rel);
    const others = d.files.filter(f => f.linked !== rel);
    box.innerHTML =
      '<label>Linked here' + (mine.length ? "" : ' <span class="hint">(none yet)</span>') + "</label>" +
      mine.map(f => '<div class="mdl-link-row"><span>' + esc(f.name) + (f.verified === false ? ' <span class="unv">(unverified)</span>' : "") + '</span><button class="btn ghost danger" data-unlink="' + esc(f.name) + '" data-for="' + esc(rel) + '" style="font-size:10.5px; padding:2px 7px">Unlink</button></div>').join("") +
      '<label>Link another gcode file (' + esc(d.folder) + ")</label>" +
      '<select class="field" data-pick><option value="">choose a file…</option>' +
      others.map(f => '<option value="' + esc(f.name) + '">' + esc(f.name) + (f.linked ? " (linked to " + esc(String(f.linked).split("/").pop()) + ")" : "") + "</option>").join("") +
      "</select>" +
      '<div class="row"><button class="btn primary" data-do-link="' + esc(rel) + '" style="font-size:11.5px; padding:4px 10px">Link</button><button class="btn ghost" data-cancel="' + esc(rel) + '" style="font-size:11px; padding:3px 8px">Close</button><span class="msg" data-msg></span></div>';
  }
  async function doLink(rel) {
    const box = editBox(rel); if (!box) return;
    const sel = box.querySelector("[data-pick]"), msg = box.querySelector("[data-msg]");
    const gcode = sel && sel.value;
    if (!gcode) { if (msg) { msg.className = "msg err"; msg.textContent = "Pick a file first."; } return; }
    if (msg) { msg.className = "msg"; msg.textContent = "linking…"; }
    const r = await jpost("/api/models/link", { gcode, file: rel, type: typeSlug() });
    if (!r.ok) { if (msg) { msg.className = "msg err"; msg.textContent = r.d.error || "could not link it"; } return; }
    applyRequest(rel, r.d.request);
    const d = await jget("/api/models/gcodes?type=" + encodeURIComponent(typeSlug()));
    if (d) renderLinkPanel(rel, d);
    // panel was just rebuilt (fresh markup, no [data-msg] to reuse) - say it at the top instead
    box.insertAdjacentHTML("afterbegin", '<div class="msg">Linked ' + esc(gcode) + (r.d.dispatched ? " - matched an open print request and queued one print of it in Dispatch." : ".") + "</div>");
  }
  async function doUnlink(gcode, rel) {
    const box = editBox(rel); if (!box) return;
    const r = await jpost("/api/models/link", { gcode });
    if (!r.ok) { alert(r.d.error || "could not unlink it"); return; }
    const d = await jget("/api/models/gcodes?type=" + encodeURIComponent(typeSlug()));
    if (d) renderLinkPanel(rel, d);
  }
  // Patches a card's badge in place from a fresh `request` object (or null),
  // without a full grid reload - used after link/unlink/clear so the panel
  // interaction stays snappy.
  function applyRequest(rel, request) {
    const it = itemOf(rel); if (it) it.requested = request || null;
    const c = cardOf(rel); const holder = c && c.querySelector(".mdl-reqhold");
    if (holder) holder.innerHTML = it ? reqBadge(it) : "";
  }
  async function clearRequest(rel) {
    const r = await jpost("/api/models/print-request/clear", { file: rel });
    if (!r.ok) { alert(r.d.error || "Could not clear it"); return; }
    applyRequest(rel, null);
  }

  // ---- v2.38: Convert to U1 ----------------------------------------------------
  const small = 'style="font-size:11.5px; padding:4px 10px"', tiny = 'style="font-size:11px; padding:3px 8px"';
  async function doConvert(rel) {
    const box = editBox(rel); if (!box) return;
    box.className = "mdl-edit show";
    box.innerHTML = '<div class="msg">Converting…</div>';
    const r = await jpost("/api/models/convert", { file: rel });
    const close = '<button class="btn ghost" data-cancel="' + esc(rel) + '" ' + tiny + '>Close</button>';
    const d = r.d || {};
    if (!r.ok) {
      box.innerHTML = '<div class="msg err">' + esc(d.error || "Could not convert it") + "</div>" +
        '<div class="row">' + (d.exists && d.rel ? '<button class="btn primary" data-open="' + esc(d.rel) + '" ' + small + ">Open the U1 copy in Orca</button>" : "") +
        (r.status === 409 && !d.exists ? '<button class="btn primary" data-showcfg="1" ' + small + ">Folder settings</button>" : "") + close + "</div>";
      return;
    }
    if (d.already) {
      box.innerHTML = '<div class="msg">This one is already a Snapmaker U1 project - open it as it is.</div><div class="row"><button class="btn primary" data-open="' + esc(rel) + '" ' + small + ">Open in Orca</button>" + close + "</div>";
      return;
    }
    const warn = [];
    for (const m of d.mismatched || []) warn.push("Filament " + m.slot + " was " + esc(m.was) + " in the original; the copy uses your " + esc(m.now) + " preset. Pick " + esc(m.was) + " for that slot in Orca if you are printing it in " + esc(m.was) + ".");
    if (d.over4) warn.push("The original paints with " + d.over4 + " filaments; the U1 has 4. Colors past the fourth need re-assigning in Orca.");
    if (d.remapped) warn.push(d.remapped + " object" + (d.remapped === 1 ? " was" : "s were") + " set to a filament past 4 and now use" + (d.remapped === 1 ? "s" : "") + " filament 1.");
    for (const n of d.notes || []) warn.push(esc(n) + ".");
    const kept = (d.kept || []).length ? esc(d.kept.join(", ")) : "nothing that differs from your U1 profile";
    box.innerHTML =
      '<div class="msg">✓ Wrote <b>' + esc(String(d.rel).split("/").pop()) + "</b> beside it.</div>" +
      '<div class="msg" title="' + esc((d.carried || []).join(", ")) + '">Kept from the designer: ' + kept + ".</div>" +
      '<div class="msg">Speeds, temperatures, retraction and cooling: your U1 profile' + (d.process && d.process.id ? " (" + esc(d.process.id) + ")" : "") + ".</div>" +
      warn.map(w => '<div class="msg" style="color:var(--warn,#F5A524)">' + w + "</div>").join("") +
      '<div class="row"><button class="btn primary" data-open="' + esc(d.rel) + '" ' + small + ">Open the U1 copy in Orca</button>" + close + "</div>";
    // The copy joins the grid right after the original.
    if (d.item && DATA && !cardOf(d.rel)) {
      const i = DATA.items.findIndex(x => x.rel === rel);
      DATA.items.splice(i + 1, 0, d.item);
      DATA.total++; DATA.total_all++;
      const c = cardOf(rel);
      if (c) { c.insertAdjacentHTML("afterend", card(d.item)); lazyInfo(); }
      EL.querySelector("#mdl-count").textContent = DATA.total_all + " file" + (DATA.total_all === 1 ? "" : "s");
    }
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
        '<div class="st">Suggesting settings needs your Anthropic API key. Open <b>Settings → AI pre-flight</b>, paste the key, press Save, then press Suggest settings again. Nothing is sent until then.</div>';
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
    SHOWNKEY = null;
    // Switching printers after an answer leaves the table describing the old
    // one; say so instead of quietly loading it for the new one.
    const psel = box.querySelector("#mdl-advprinter");
    if (psel) psel.addEventListener("change", () => {
      const out = box.querySelector("#mdl-tuned");
      if (SHOWNKEY && out) out.innerHTML = '<span class="skip">These suggestions are for ' + esc(SHOWNFOR) + ". Press Ask to get them for the printer you picked; Open in Orca loads the ones shown.</span>";
    });
    runSuggest(false);
  }
  // v2.41: the answer on screen - Open in Orca loads exactly this one.
  let SHOWNKEY = null, SHOWNFOR = "";
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
    SHOWNKEY = r.d.key || null; SHOWNFOR = r.d.printer || "any U1";
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
    // v2.42: load these into a scratch copy and open it in Orca. The library
    // file is never written; the copy is cleaned up after three days.
    if (s.settings && s.settings.length)
      h += '<div class="mdl-tunerow"><button class="btn primary" id="mdl-tuneopen" style="font-size:12px; padding:5px 12px" title="Opens a copy of this 3MF in Orca with these settings already set. Your file is not changed; use Save As in Orca to keep the tuned project.">Open in Orca with these settings</button>' +
        '<span class="st">a copy opens - your file is not changed</span></div><div class="mdl-tuned" id="mdl-tuned"></div>';
    body.innerHTML = h || '<div class="st">No settings came back.</div>';
    const when = new Date(r.d.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    foot.innerHTML = esc(r.d.model || "") + (r.d.cost != null ? " · " + money(r.d.cost) : "") + " · " + (r.d.cached ? "from cache, " + when : when) +
      ' · <a href="#" data-again="1" style="color:var(--signal)">Ask again</a>' +
      ' · <a href="/api/advisor/model/brief?file=' + encodeURIComponent(rel) + (pid != null ? "&printer=" + pid : "") + '" target="_blank" rel="noopener" style="color:var(--signal)">what was sent</a>' +
      ' · <span title="Claude reads measured numbers, the plate render and the designer\'s profile; it does not slice the file.">advice, not a guarantee</span>';
  }
  async function openTuned(btn) {
    const rel = ADVFILE, pid = pickPrinter();
    const out = EL.querySelector("#mdl-tuned");
    btn.disabled = true; const was = btn.textContent; btn.textContent = "Opening…";
    const r = await jpost("/api/models/open-tuned", { file: rel, type: typeSlug(), printer: pid == null ? "" : pid, key: SHOWNKEY || "" });
    btn.disabled = false; btn.textContent = was;
    if (!out || ADVFILE !== rel) return;
    if (!r.ok) { out.innerHTML = '<span class="skip">' + esc(r.d.error || "Could not open it") + "</span>"; return; }
    const d = r.d, ap = d.applied || [], sk = d.skipped || [];
    let h = "<b>Opened in Orca</b> with " + ap.length + " setting" + (ap.length === 1 ? "" : "s") + " loaded" +
      (ap.length ? ": " + ap.map(a => esc(a.key) + " " + esc(a.to)).join(", ") : "") + ". They show as changed in Orca's settings, so you can put any of them back.";
    if (d.converted) h += "<br>It was a project for " + esc(d.converted.from) + ", so the copy was made a U1 project first (like Convert to U1).";
    if (sk.length) h += '<br><span class="skip">Not applied:</span> ' + sk.map(x => esc(x.key) + (x.value ? " (" + esc(x.value) + ")" : "") + " - " + esc(x.reason)).join("; ") + ".";
    h += "<br>Slice and save the gcode as usual. To keep the tuned project, use Save As in Orca; otherwise the copy is removed in three days.";
    out.innerHTML = h;
    pollSessions(true);
  }
  function onAdvClick(e) {
    const t = e.target.closest("button, a"); if (!t) return;
    if (t.dataset.close) { const box = EL.querySelector("#mdl-adv"); box.className = "mdl-adv"; box.innerHTML = ""; ADVFILE = null; return; }
    if (t.id === "mdl-advask") { runSuggest(false); return; }
    if (t.id === "mdl-tuneopen") { openTuned(t); return; }
    if (t.dataset.again) { e.preventDefault(); runSuggest(true); }
  }

  // Colors and object counts come from inside each zip; fetch them only for
  // cards that are on screen, a few at a time.
  let IO = null;
  // H22: cards that scroll into view within 120 ms ask in ONE request
  // (/api/models/info-batch) instead of one each.
  let INFO_Q = [], INFO_T = 0;
  function lazyInfo() {
    if (!("IntersectionObserver" in window)) { EL.querySelectorAll(".mdl-chips[data-info]").forEach(b => queueInfo(b)); return; }
    if (IO) IO.disconnect();
    IO = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const box = en.target; IO.unobserve(box);
        queueInfo(box);
      }
    }, { rootMargin: "200px" });
    EL.querySelectorAll(".mdl-chips[data-info]").forEach(b => IO.observe(b));
  }
  function queueInfo(box) {
    INFO_Q.push(box);
    if (INFO_T) return;
    INFO_T = setTimeout(async () => {
      INFO_T = 0;
      const batch = INFO_Q.splice(0, 60);
      const rels = [...new Set(batch.map(b => b.dataset.info))];
      const d = await jget("/api/models/info-batch?files=" + rels.map(encodeURIComponent).join(","));
      const items = (d && d.items) || {};
      for (const b of batch) fillInfo(b, items[b.dataset.info] || null);
      if (INFO_Q.length) queueInfo(INFO_Q.shift());
    }, 120);
  }
  function fillInfo(box, d) {
    if (!d || d.error) { box.innerHTML = '<span class="k">no project data</span>'; return; }
    const cols = (d.colors_used && d.colors_used.length ? d.colors_used : d.colors) || [];
    // F13a: the card's top edge is the project's palette
    const card0 = box.closest(".mdl-card");
    if (card0 && cols.length) {
      const stops = cols.slice(0, 8);
      const step = 100 / stops.length;
      card0.style.setProperty("--pal", "linear-gradient(90deg, " + stops.map((c, i) => esc(c) + " " + Math.round(i * step) + "% " + Math.round((i + 1) * step) + "%").join(", ") + ")");
    }
    let h = cols.slice(0, 8).map(c => '<span class="mdl-chip" style="background:' + esc(c) + '" title="' + esc(c) + '"></span>').join("");
    const bits = [];
    if (cols.length) bits.push(cols.length + (cols.length === 1 ? " color" : " colors"));
    if (d.objects && d.objects.length) bits.push(d.objects.length + (d.objects.length === 1 ? " object" : " objects"));
    if (d.printer) bits.push("for " + d.printer);
    h += '<span class="k" title="' + esc((d.objects || []).map(o => o.name).join(", ")) + '">' + esc(bits.join(" · ") || "no project data") + "</span>";
    box.innerHTML = h;
    // v2.38: a U1 project has nothing to convert.
    const cv = box.closest(".mdl-card") && box.closest(".mdl-card").querySelector("[data-convert]");
    if (cv && d.printer === "Snapmaker U1") { cv.disabled = true; cv.title = "Already a Snapmaker U1 project"; }
  }

  async function onGridClick(e) {
    const sg = e.target.closest("[data-suggest]");
    if (sg) { openSuggest(sg.dataset.suggest); return; }
    const t = e.target.closest("button");
    // v2.36: Rename / Attributes / Delete live behind ⋯ - three buttons on
    // every card was 180 extra buttons a page for things done now and then.
    if (t && t.dataset.more != null) { const c = cardOf(t.dataset.more); if (c) { const open = c.classList.toggle("more"); if (!open) closeEdit(t.dataset.more); } return; }
    if (t && t.dataset.convert != null) { closeEdit(t.dataset.convert); doConvert(t.dataset.convert); return; }
    if (t && t.dataset.showcfg != null) { EL.querySelector("#mdl-cfg").classList.add("show"); EL.querySelector("#mdl-cfg").scrollIntoView({ block: "nearest" }); return; }
    if (t && t.dataset.clearfilter != null) { if (t.dataset.clearfilter === "req") REQ_ONLY = false; else { Q = ""; CREATOR = ""; REQ_ONLY = false; EL.querySelector("#mdl-q").value = ""; } OFFSET = 0; load(); return; }
    if (t && t.dataset.rename != null) { closeEdit(t.dataset.rename); askRename(t.dataset.rename); return; }
    if (t && t.dataset.attrs != null) { closeEdit(t.dataset.attrs); openAttrs(t.dataset.attrs); return; }
    if (t && t.dataset.del != null) { closeEdit(t.dataset.del); askDelete(t.dataset.del); return; }
    if (t && t.dataset.link != null) { closeEdit(t.dataset.link); askLink(t.dataset.link); return; }
    if (t && t.dataset.saveAttrs != null) { saveAttrs(t.dataset.saveAttrs); return; }
    if (t && t.dataset.doRename != null) { doRename(t.dataset.doRename); return; }
    if (t && t.dataset.doDel != null) { doDelete(t.dataset.doDel); return; }
    if (t && t.dataset.doLink != null) { doLink(t.dataset.doLink); return; }
    if (t && t.dataset.unlink != null) { doUnlink(t.dataset.unlink, t.dataset.for); return; }
    if (t && t.dataset.clearreq != null) { clearRequest(t.dataset.clearreq); return; }
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
      if (s.state === "watching") return '<div class="mdl-sess"><span>⏳ <b>' + f + "</b> is open in Orca" + (s.tuned ? " (a copy with the suggested settings)" : "") + ". Slice it, then save the gcode into the library folder - the Hub is watching for it.</span><span class=\"k\">since " + new Date(s.launchedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + '</span><button class="btn ghost" data-dismiss="' + s.id + '" style="font-size:11px; padding:3px 9px; margin-left:auto">Stop watching</button></div>';
      if (s.state === "done") return '<div class="mdl-sess"><span>✓ Orca saved <b>' + esc(s.newGcode) + "</b>.</span>" +
        '<button class="btn primary" data-select="' + esc(s.newGcode) + '" style="font-size:11.5px; padding:4px 10px">Select in library</button>' +
        (window.HUB_FEATURES && window.HUB_FEATURES.dispatch !== false
          ? (s.queued ? '<span class="k">✓ ' + (s.queued.existing ? "already in the Dispatch queue" : "queued in Dispatch") + "</span>"
                      : '<button class="btn ghost" data-sendsess="' + s.id + '" style="font-size:11.5px; padding:4px 10px">Send to Dispatch</button>')
          : "") +
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
    if (t.dataset.sendsess) {
      // v2.40: queued through the session, so it happens once however often
      // the strip is redrawn (see /api/models/sessions/send).
      t.disabled = true;
      const r = await jpost("/api/models/sessions/send", { id: Number(t.dataset.sendsess) });
      if (!r.ok) { t.disabled = false; alert(r.d.error || "Dispatch refused it"); return; }
      // 2.43.0: the session leaves the strip once its gcode is in Dispatch.
      t.textContent = r.d.existing ? "Already in Dispatch" : "Queued in Dispatch";
      pollSessions(true);
    }
  }

  function onShow() {
    const before = Q + "|" + CREATOR + "|" + SORT + "|" + REQ_ONLY;
    readHash();
    if (Q + "|" + CREATOR + "|" + SORT + "|" + REQ_ONLY !== before) { const qi = EL.querySelector("#mdl-q"); if (qi) qi.value = Q; const seg = EL.querySelector("#mdl-sort"); if (seg) { seg.outerHTML = sortSeg(); bindSort(); } OFFSET = 0; }
    load(); pollSessions(true); jget("/api/advisor").then(s => { if (s) ADV = s; });
  }

  window.HubModules.register("models", { tab: "Models", mount, onShow });
})();
