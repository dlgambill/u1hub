// public/modules/logbook-ui.js - the Logbook tab (v2.37): what went wrong on
// each printer, what fixed it, and the upkeep that is coming due.
// Server side: modules/logbook.js. Three blocks, top to bottom, in the order
// a person standing at the farm needs them: what is due now, the log, and the
// schedule that makes things come due. Works on a phone - the log is the
// thing you want in your hand when you are at the printer with the fix.
"use strict";
(function () {
  let EL = null, DATA = null, BUSY = false;
  let F = { printer: "", kind: "", q: "" };          // log filters
  let OPEN = null;                                   // which inline form is open: "entry" | "task" | "done:<task>:<idx>" | "fix:<id>" | "rm:<id>" | "trm:<id>"
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
      return { ok: r.ok, d: await r.json().catch(() => ({})) };
    } catch (e) { return { ok: false, d: { error: e.message } }; }
  }
  const fmtDate = t => new Date(t).toLocaleString([], { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric", hour: "numeric", minute: "2-digit" });
  const fmtH = h => h == null ? "?" : (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1)) + " h";
  const fmtSpan = ms => { const m = Math.round(ms / 60000); if (m < 60) return m + " min"; const h = Math.round(m / 60); if (h < 48) return h + " h"; return Math.round(h / 24) + " days"; };
  const every = t => [t.every_hours ? t.every_hours + " print h" : "", t.every_days ? t.every_days + " days" : ""].filter(Boolean).join(" or ");
  const SOURCES = { firmware: "from the printer", "maintenance-mode": "out of service", schedule: "scheduled", you: "" };
  // Starting points only. Upkeep intervals differ by printer and by how hard
  // it is run; the note under them says so.
  const SUGGEST = [
    ["Clean the nozzle wiper", 100, null], ["Clean nozzles and check for leaks", 200, null],
    ["Check belt tension", 300, null], ["Lubricate rods and linear rails", 500, null],
    ["Wash the build plate", null, 7], ["Replace desiccant", null, 30]
  ];

  function style() {
    if (document.getElementById("lgbcss")) return;
    const s = document.createElement("style");
    s.id = "lgbcss";
    s.textContent = [
      ".lgb-sec{margin:18px 0 8px; font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--accent,#f5b316); display:flex; gap:10px; align-items:center; flex-wrap:wrap;}",
      ".lgb-sec .sp{flex:1}",
      ".lgb-sec .btn{font-family:inherit; letter-spacing:normal; text-transform:none;}",
      ".lgb-hours{font-family:var(--mono); font-size:11px; color:var(--ink-faint); display:flex; flex-wrap:wrap; gap:4px 12px;}",
      ".lgb-hours b{color:var(--ink-dim); font-weight:600;}",
      ".lgb-row{display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); margin-bottom:8px; flex-wrap:wrap;}",
      ".lgb-row .main{flex:1 1 260px; min-width:0;}",
      ".lgb-row .t{font-weight:600; color:var(--ink); overflow-wrap:anywhere;}",
      ".lgb-row .s{font-family:var(--mono); font-size:11px; color:var(--ink-faint); margin-top:3px; overflow-wrap:anywhere;}",
      ".lgb-row .fix{margin-top:6px; color:var(--ink-dim); overflow-wrap:anywhere;}",
      ".lgb-row .fix b{color:var(--ok,#3dd68c); font-weight:600;}",
      ".lgb-row .acts{display:flex; gap:6px; align-items:center; flex-wrap:wrap;}",
      ".lgb-row .btn{font-size:11.5px; padding:4px 9px;}",
      ".lgb-row .btn.danger{color:var(--bad,#e5484d); border-color:color-mix(in srgb, var(--bad,#e5484d) 45%, var(--line));}",
      ".lgb-pill{font-family:var(--mono); font-size:10px; padding:1px 7px; border-radius:99px; border:1px solid var(--line); color:var(--ink-dim); white-space:nowrap;}",
      ".lgb-pill.due{color:var(--bad,#e5484d); border-color:color-mix(in srgb, var(--bad,#e5484d) 55%, var(--line));}",
      ".lgb-pill.soon{color:var(--warn,#f5b316); border-color:color-mix(in srgb, var(--warn,#f5b316) 55%, var(--line));}",
      ".lgb-pill.ok{color:var(--ok,#3dd68c);}",
      ".lgb-pill.issue{color:var(--bad,#e5484d);} .lgb-pill.maintenance{color:var(--ok,#3dd68c);} .lgb-pill.note{color:var(--ink-dim);}",
      ".lgb-chips{display:flex; flex-wrap:wrap; gap:4px; margin-top:6px;}",
      ".lgb-form{display:grid; gap:8px; padding:12px; border:1px dashed var(--line); border-radius:10px; margin-bottom:10px;}",
      ".lgb-form .r{display:flex; gap:8px; flex-wrap:wrap; align-items:center;}",
      ".lgb-form .field{flex:1 1 160px; min-width:0;}",
      ".lgb-form input.num{flex:0 0 90px;}",
      ".lgb-form label{font-size:12px; color:var(--ink-dim); display:flex; gap:6px; align-items:center;}",
      ".lgb-inline{display:flex; gap:6px; flex:1 1 100%; flex-wrap:wrap; margin-top:6px;}",
      ".lgb-inline .field{flex:1 1 200px; min-width:0;}",
      ".lgb-sugg{display:flex; flex-wrap:wrap; gap:6px;} .lgb-sugg .btn{font-size:11px; padding:3px 8px;}",
      ".lgb-empty{color:var(--ink-faint); padding:10px 2px;}",
      ".lgb-filters{display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px;} .lgb-filters .field{flex:0 1 180px; min-width:0;} .lgb-filters input.field{flex:1 1 200px;}",
      ".lgb-msg{font-size:12px; color:var(--bad,#e5484d);}",
      // the printer-card line (drawn by app.js from /api/fleet's upkeep field)
      ".upkeepline{font-size:12px; color:var(--ink-dim); cursor:pointer; display:flex; gap:6px; align-items:center;}",
      ".upkeepline .lgb-pill{font-size:10px;}",
      ".upkeepline:hover{color:var(--ink);}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function mount(el) {
    EL = el; style();
    el.innerHTML =
      '<div class="sechead"><h2>Logbook</h2><span class="count" id="lgb-count"></span></div>' +
      '<p class="subnote">What went wrong on each printer, what fixed it, and the upkeep coming due. Pauses the printer reports and printers you take out of service are logged for you; add the fix so it is there next time.</p>' +
      '<div class="lgb-hours" id="lgb-hours"></div>' +
      '<div id="lgb-due"></div><div id="lgb-log"></div><div id="lgb-sched"></div>';
    el.addEventListener("click", onClick);
    // Filters redraw only the list below them, so the search box keeps its cursor.
    el.addEventListener("input", e => { if (e.target.id === "lgb-q") { F.q = e.target.value; renderLogList(); } });
    el.addEventListener("change", e => {
      if (e.target.id === "lgb-fp") { F.printer = e.target.value; renderLogList(); }
      if (e.target.id === "lgb-fk") { F.kind = e.target.value; renderLogList(); }
    });
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.matches("input.field") && e.target.closest("[data-enter]")) { e.preventDefault(); e.target.closest("[data-enter]").querySelector("[data-go]").click(); }
      if (e.key === "Escape" && OPEN) { OPEN = null; render(); }
    });
  }
  async function load(refresh) {
    if (BUSY) return; BUSY = true;
    try { const d = await jget("/api/logbook" + (refresh ? "?refresh=1" : "")); if (d) { DATA = d; render(); } }
    finally { BUSY = false; }
  }
  function onShow() { load(false); }

  const printerOpts = (sel, withAll) => (withAll ? '<option value="' + (withAll === "all" ? "all" : "") + '"' + (sel === "all" || sel === "" ? " selected" : "") + ">" + (withAll === "all" ? "All printers" : "All printers") + "</option>" : "") +
    (DATA ? DATA.printers : []).map(p => '<option value="' + p.idx + '"' + (String(sel) === String(p.idx) ? " selected" : "") + ">" + esc(p.name) + "</option>").join("");

  function render() { if (!EL || !DATA) return; renderHead(); renderDue(); renderLog(); renderSched(); }
  function renderHead() {
    const due = DATA.status.filter(r => r.status === "due").length;
    EL.querySelector("#lgb-count").textContent = DATA.total_entries + " entr" + (DATA.total_entries === 1 ? "y" : "ies") + (due ? " · " + due + " due" : "");
    EL.querySelector("#lgb-hours").innerHTML = "Print hours: " + DATA.printers.map(p => "<span><b>" + esc(p.name) + "</b> " + fmtH(p.hours) + "</span>").join("") +
      ' <a href="#" data-refresh title="Ask every printer for its hours now">refresh</a>';
  }
  function progress(r) {
    const parts = [];
    if (r.every_hours) parts.push(r.since_hours == null ? "? of " + r.every_hours + " h" : Math.round(r.since_hours) + " of " + r.every_hours + " h");
    if (r.every_days) parts.push(r.since_days == null ? "" : Math.round(r.since_days) + " of " + r.every_days + " days");
    return r.last ? parts.filter(Boolean).join(" · ") : "never done";
  }
  function renderDue() {
    const rows = DATA.status.filter(r => r.status === "due" || r.status === "soon").sort((a, b) => (b.status === "due") - (a.status === "due") || (b.frac === Infinity ? 99 : b.frac) - (a.frac === Infinity ? 99 : a.frac));
    const box = EL.querySelector("#lgb-due");
    if (!rows.length) { box.innerHTML = DATA.tasks.length ? '<div class="lgb-sec">Due</div><div class="lgb-empty">Nothing due. ' + DATA.status.length + " scheduled check" + (DATA.status.length === 1 ? "" : "s") + " across the farm.</div>" : ""; return; }
    box.innerHTML = '<div class="lgb-sec">Due <span class="lgb-pill due">' + rows.filter(r => r.status === "due").length + " due</span>" +
      (rows.some(r => r.status === "soon") ? ' <span class="lgb-pill soon">' + rows.filter(r => r.status === "soon").length + " coming up</span>" : "") + "</div>" +
      rows.map(r => {
        const key = "done:" + r.task_id + ":" + r.printer;
        return '<div class="lgb-row"><div class="main"><div class="t">' + esc(r.name) + " · " + esc(r.title) + '</div><div class="s">every ' + esc(every(r)) + " · " + esc(progress(r)) +
          (r.last ? " · last " + fmtDate(r.last.at) : "") + "</div></div>" +
          '<div class="acts"><span class="lgb-pill ' + r.status + '">' + (r.status === "due" ? "due" : "soon") + '</span><button class="btn primary" data-open="' + esc(key) + '">Done</button></div>' +
          (OPEN === key ? '<div class="lgb-inline" data-enter><input class="field" id="lgb-note" placeholder="Note (optional): what you did, parts used"><button class="btn primary" data-go data-done="' + esc(r.task_id) + '" data-p="' + r.printer + '">Mark done</button><button class="btn ghost" data-close>Cancel</button></div>' : "") +
          "</div>";
      }).join("");
    focusSoon("#lgb-note");
  }
  function renderLog() {
    const box = EL.querySelector("#lgb-log");
    if (!box) return;
    const head = '<div class="lgb-sec">Log<span class="sp"></span><button class="btn ghost" data-open="entry">+ Add entry</button></div>';
    const form = OPEN === "entry" ? '<div class="lgb-form" data-enter>' +
      '<div class="r"><select class="field" id="lgb-ep">' + printerOpts(F.printer || (DATA.printers[0] ? 0 : "")) + '</select>' +
      '<select class="field" id="lgb-ek"><option value="issue">Issue</option><option value="maintenance">Maintenance</option><option value="note">Note</option></select></div>' +
      '<input class="field" id="lgb-ew" placeholder="What happened (e.g. clog on nozzle 2, layer shift at 40 mm)">' +
      '<input class="field" id="lgb-ef" placeholder="What fixed it (leave blank if it is still open)">' +
      '<div class="r"><button class="btn primary" data-go data-addentry>Save</button><button class="btn ghost" data-close>Cancel</button><span class="lgb-msg" id="lgb-emsg"></span></div></div>' : "";
    const filters = '<div class="lgb-filters"><select class="field" id="lgb-fp">' + printerOpts(F.printer, true) + '</select>' +
      '<select class="field" id="lgb-fk"><option value="">Everything</option><option value="issue"' + (F.kind === "issue" ? " selected" : "") + '>Issues</option><option value="maintenance"' + (F.kind === "maintenance" ? " selected" : "") + '>Maintenance</option><option value="note"' + (F.kind === "note" ? " selected" : "") + '>Notes</option></select>' +
      '<input class="field" id="lgb-q" placeholder="Search what and fix (e.g. clog)" value="' + esc(F.q) + '"></div>';
    box.innerHTML = head + form + filters + '<div id="lgb-list"></div>';
    renderLogList();
    focusSoon(OPEN === "entry" ? "#lgb-ew" : null);
  }
  function renderLogList() {
    const box = EL.querySelector("#lgb-list");
    if (!box) return;
    const q = F.q.trim().toLowerCase();
    const list = DATA.entries.filter(e => (F.printer === "" || String(e.printer) === F.printer) && (!F.kind || e.kind === F.kind) &&
      (!q || (e.what + " " + (e.fix || "") + " " + (e.name || "") + " " + (e.file || "")).toLowerCase().includes(q)));
    const rows = list.slice(0, 300).map(e => {
      const src = SOURCES[e.source] || "";
      const away = e.source === "maintenance-mode" ? (e.back_at ? " · back in service after " + fmtSpan(e.back_at - e.at) : " · still out of service") : "";
      const fixKey = "fix:" + e.id, rmKey = "rm:" + e.id;
      const fix = e.fix ? '<div class="fix"><b>Fix:</b> ' + esc(e.fix) + "</div>"
        : (e.kind === "issue" ? (OPEN === fixKey
            ? '<div class="lgb-inline" data-enter><input class="field" id="lgb-fx" placeholder="What fixed it"><button class="btn primary" data-go data-savefix="' + esc(e.id) + '">Save</button><button class="btn ghost" data-close>Cancel</button></div>'
            : '<div class="fix"><a href="#" data-open="' + esc(fixKey) + '">' + (e.source === "maintenance-mode" && e.back_at ? "What fixed it?" : "Add the fix") + "</a></div>") : "");
      return '<div class="lgb-row"><div class="main"><div class="t">' + esc(e.what) + '</div><div class="s">' + fmtDate(e.at) + " · " + esc(e.name || "") +
        (e.hours != null ? " · at " + fmtH(e.hours) : "") + (src ? " · " + src : "") + away + (e.file ? " · " + esc(String(e.file).replace(/\.gcode$/i, "")) : "") + "</div>" + fix + "</div>" +
        '<div class="acts"><span class="lgb-pill ' + e.kind + '">' + e.kind + "</span>" +
        (OPEN === rmKey ? '<button class="btn ghost danger" data-rm="' + esc(e.id) + '">Delete it</button><button class="btn ghost" data-close>Keep</button>' : '<button class="btn ghost" data-open="' + esc(rmKey) + '" title="Delete this entry" aria-label="Delete">×</button>') +
        "</div></div>";
    }).join("");
    box.innerHTML = (rows || '<div class="lgb-empty">' + (DATA.entries.length ? "Nothing matches." : "Nothing logged yet. Pauses the printers report land here by themselves, and so does any printer you take out of service.") + "</div>") +
      (list.length > 300 ? '<div class="lgb-empty">Showing the newest 300 of ' + list.length + ".</div>" : "");
    if (OPEN && OPEN.startsWith("fix:")) focusSoon("#lgb-fx");
  }
  function renderSched() {
    const box = EL.querySelector("#lgb-sched");
    const head = '<div class="lgb-sec">Schedule<span class="sp"></span><button class="btn ghost" data-open="task">+ Add task</button></div>';
    const form = OPEN === "task" ? '<div class="lgb-form" data-enter>' +
      '<div class="r"><input class="field" id="lgb-tt" placeholder="Task (e.g. Lubricate rods and linear rails)"><select class="field" id="lgb-tp">' + printerOpts("all", "all") + "</select></div>" +
      '<div class="r"><label>every <input class="field num" id="lgb-th" type="number" min="1" placeholder="—"> print hours</label><label>or every <input class="field num" id="lgb-td" type="number" min="1" placeholder="—"> days</label>' +
      '<label title="Leave off to start counting from now"><input type="checkbox" id="lgb-tn"> never done yet (due now)</label></div>' +
      '<div class="lgb-sugg">' + SUGGEST.map((s, i) => '<button class="btn ghost" data-sugg="' + i + '">' + esc(s[0]) + " · " + (s[1] ? s[1] + " h" : s[2] + " days") + "</button>").join("") + "</div>" +
      '<div class="s" style="font-size:11px;color:var(--ink-faint)">Suggestions are starting points, not your printer maker\'s numbers - check its manual and adjust.</div>' +
      '<div class="r"><button class="btn primary" data-go data-addtask>Save</button><button class="btn ghost" data-close>Cancel</button><span class="lgb-msg" id="lgb-tmsg"></span></div></div>' : "";
    const byTask = {};
    for (const r of DATA.status) (byTask[r.task_id] = byTask[r.task_id] || []).push(r);
    const rows = DATA.tasks.map(t => {
      const st = byTask[t.id] || [];
      const rmKey = "trm:" + t.id;
      return '<div class="lgb-row"><div class="main"><div class="t">' + esc(t.title) + '</div><div class="s">' + (t.printer === "all" ? "all printers" : esc((DATA.printers[t.printer] || {}).name || "")) + " · every " + esc(every(t)) + "</div>" +
        '<div class="lgb-chips">' + st.map(r => '<span class="lgb-pill ' + (r.status === "unknown" ? "" : r.status) + '" title="' + esc(progress(r)) + '">' + esc(r.name) + (r.status === "due" ? " due" : r.status === "soon" ? " soon" : "") + "</span>").join("") + "</div></div>" +
        '<div class="acts">' + (OPEN === rmKey ? '<button class="btn ghost danger" data-trm="' + esc(t.id) + '">Remove task</button><button class="btn ghost" data-close>Keep</button>' : '<button class="btn ghost" data-open="' + esc(rmKey) + '" title="Remove this task" aria-label="Remove">×</button>') + "</div></div>";
    }).join("");
    box.innerHTML = head + form + (rows || '<div class="lgb-empty">No upkeep scheduled. Add a task - every so many print hours, every so many days, or both - and it shows on the printer card when it comes due.</div>');
    focusSoon(OPEN === "task" ? "#lgb-tt" : null);
  }
  function focusSoon(sel) { if (!sel) return; setTimeout(() => { const i = EL.querySelector(sel); if (i && document.activeElement !== i) i.focus(); }, 0); }
  const val = id => { const x = EL.querySelector(id); return x ? (x.type === "checkbox" ? x.checked : x.value) : ""; };

  async function onClick(e) {
    const a = e.target.closest("[data-open],[data-close],[data-refresh],[data-done],[data-savefix],[data-rm],[data-trm],[data-addentry],[data-addtask],[data-sugg]");
    if (!a) return;
    e.preventDefault();
    const d = a.dataset;
    if (d.open != null) { OPEN = OPEN === d.open ? null : d.open; render(); return; }
    if (d.close != null) { OPEN = null; render(); return; }
    if (d.refresh != null) { a.textContent = "asking…"; await load(true); return; }
    if (d.sugg != null) {
      const s = SUGGEST[+d.sugg];
      EL.querySelector("#lgb-tt").value = s[0]; EL.querySelector("#lgb-th").value = s[1] || ""; EL.querySelector("#lgb-td").value = s[2] || "";
      return;
    }
    let r = null;
    if (d.done != null) r = await jpost("/api/logbook/tasks/done", { id: d.done, printer: +d.p, note: val("#lgb-note") });
    else if (d.savefix != null) r = await jpost("/api/logbook/entries/update", { id: d.savefix, fix: val("#lgb-fx") });
    else if (d.rm != null) r = await jpost("/api/logbook/entries/remove", { id: d.rm });
    else if (d.trm != null) r = await jpost("/api/logbook/tasks/remove", { id: d.trm });
    else if (d.addentry != null) {
      r = await jpost("/api/logbook/entries", { printer: +val("#lgb-ep"), kind: val("#lgb-ek"), what: val("#lgb-ew"), fix: val("#lgb-ef") });
      if (!r.ok) { EL.querySelector("#lgb-emsg").textContent = r.d.error || "Could not save"; return; }
    } else if (d.addtask != null) {
      const p = val("#lgb-tp");
      r = await jpost("/api/logbook/tasks", { title: val("#lgb-tt"), printer: p === "all" ? "all" : +p, every_hours: val("#lgb-th"), every_days: val("#lgb-td"), due_now: val("#lgb-tn") });
      if (!r.ok) { EL.querySelector("#lgb-tmsg").textContent = r.d.error || "Could not save"; return; }
    }
    if (r && !r.ok) { alertInline(r.d.error || "That did not work"); return; }
    OPEN = null;
    await load(false);
    if (typeof window.loadFleet === "function") window.loadFleet();   // the card's due line
  }
  function alertInline(msg) { const m = document.createElement("div"); m.className = "lgb-msg"; m.textContent = msg; EL.querySelector("#lgb-due").prepend(m); setTimeout(() => m.remove(), 5000); }

  // The printer card's "due" line (drawn by app.js) opens this tab on that printer.
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-upkeep]");
    if (!b || typeof window.setView !== "function") return;
    F.printer = String(b.dataset.upkeep); F.kind = ""; F.q = "";
    window.setView("logbook");
    setTimeout(() => { const due = EL && EL.querySelector("#lgb-due"); if (due) due.scrollIntoView({ block: "start" }); }, 150);
  });

  style();   // the printer card's due line uses these classes before the tab is ever opened
  window.HubModules.register("logbook", { tab: "Logbook", mount, onShow });
})();
