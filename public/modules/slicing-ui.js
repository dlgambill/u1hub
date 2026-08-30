// public/modules/slicing-ui.js — Slice tab (v2.12). Injected by the server
// only when the slicing feature is enabled; registers through HubModules like
// dispatch-ui does. "Queue in Dispatch" reuses dispatch's fileAction
// capability — zero server-side coupling, and the button simply doesn't
// appear when Dispatch is off.
"use strict";
(function () {
  const $id = s => document.getElementById(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const jget = async p => { const r = await fetch(p); return { status: r.status, body: await r.json().catch(() => null) }; };
  const jpost = async (p, b) => {
    const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB";
  const fmtMin = m => m == null ? "" : (m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + "m");

  let EL = null, TIMER = null, STATUS = null, CFG_OPEN = false;
  const ORCA_SESSIONS = new Map();

  async function refresh() {
    if (!EL) return;
    if (CFG_OPEN) return;   // editor open: never rebuild the DOM under the user's cursor
    if (EL.querySelector(".slc-opts")) return;   // slice options row open: same rule
    // Poll any active orca sessions
    for (const [sid, sess] of ORCA_SESSIONS) {
      if (sess.state !== "watching") continue;
      jget("/api/slice/orca-session?id=" + sid).then(sr => {
        if (sr.body && sr.body.state !== "watching") { ORCA_SESSIONS.set(sid, sr.body); }
      });
    }
    const [st, fl, jb] = await Promise.all([jget("/api/slice/status"), jget("/api/slice/files"), jget("/api/slice/jobs")]);
    STATUS = st.body || {};
    render(STATUS, (fl.body || {}).files || [], (jb.body || {}).jobs || []);
  }

  function render(st, files, jobs) {
    // Guard AGAIN here, not just at refresh() entry: the fetches above take
    // hundreds of ms, and a row opened during that window must not be wiped
    // by the write below (the race behind "it closes before I can type").
    if (!EL || CFG_OPEN || EL.querySelector(".slc-opts")) return;
    const warn = [];
    if (!st.exeFound) warn.push("Slicer not found at <code>" + esc(st.exe) + "</code>.");
    if (!st.srcFolderFound) warn.push("3MF folder not found: <code>" + esc(st.srcFolder) + "</code>.");
    if (!st.templateFound) warn.push("Transplant template missing at <code>" + esc(st.template) + "</code> — copy a known-clean U1 project (cube-u1.3mf) there. Native U1 files still slice without it.");
    const dispatchOn = !!(window.HubModules && HubModules.fileAction && HubModules.fileAction());
    const found = f => f ? '<span style="color:#3fae6a">✓</span>' : '<span style="color:#e0a020">⚠</span>';

    let h = '<div class="card" style="padding:12px 14px;margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;gap:8px"><div style="font-weight:600;flex:1">In-app slicing <span style="opacity:.55;font-weight:400">— OrcaSlicer CLI, Phase 1 (single-color)</span></div>' +
      '<button class="btn ghost" id="slc-cfg-toggle" style="font-size:12px;padding:3px 10px">⚙ Settings</button></div>' +
      '<div style="font-size:12px;opacity:.75;margin-top:4px">3MF library: <code>' + esc(st.srcFolder) + "</code> " + found(st.srcFolderFound) +
      (st.running ? ' · <b>slicing now</b>' : "") + (st.queued ? " · " + st.queued + " queued" : "") + "</div>" +
      warn.map(w => '<div style="font-size:12px;color:#e0a020;margin-top:6px">⚠ ' + w + "</div>").join("") +
      '<div id="slc-cfg" style="display:none;margin-top:10px;padding-top:10px;border-top:1px solid rgba(128,128,128,.2)">' +
        '<div style="font-size:12px;margin-bottom:3px">3MF library folder ' + found(st.srcFolderFound) + '</div>' +
        '<input id="slc-cfg-src" value="' + esc(st.srcFolder) + '" style="width:100%;font-size:12px;padding:5px 8px;box-sizing:border-box" spellcheck="false">' +
        '<div style="font-size:12px;margin:8px 0 3px">Slicer executable ' + found(st.exeFound) + '</div>' +
        '<input id="slc-cfg-exe" value="' + esc(st.exe) + '" style="width:100%;font-size:12px;padding:5px 8px;box-sizing:border-box" spellcheck="false">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">' +
        '<button class="btn" id="slc-cfg-save" style="font-size:12px;padding:4px 12px">Save</button>' +
        '<span id="slc-cfg-msg" style="font-size:12px;opacity:.7"></span>' +
        '<span style="flex:1"></span><span style="font-size:11px;opacity:.5">applies immediately — no restart</span></div>' +
      "</div></div>";

    h += '<div class="card" style="padding:12px 14px;margin-bottom:10px"><div style="font-weight:600;margin-bottom:6px">3MF library</div>';
    if (!files.length) h += '<div style="font-size:13px;opacity:.7">No .3mf files found. Drop projects into the library folder above.</div>';
    h += files.slice(0, 100).map(f =>
      '<div style="padding:5px 0;border-bottom:1px solid rgba(128,128,128,.12)">' +
      '<div style="display:flex;align-items:center;gap:6px">' +
      '<img loading="lazy" src="/api/slice/thumb?file=' + encodeURIComponent(f.file) + '" onerror="this.style.display=\'none\'" style="width:30px;height:30px;flex-shrink:0;object-fit:contain;border-radius:5px;background:rgba(128,128,128,.12)">' +
      '<div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(f.file) + '">' + esc(f.file) + "</div>" +
      '<span style="font-size:11px;opacity:.5;flex-shrink:0">' + fmtSize(f.size) + "</span></div>" +
      '<div style="display:flex;gap:5px;margin-top:4px;flex-wrap:wrap">' +
      '<button class="btn ghost slc-insp" data-f="' + esc(f.file) + '" title="Check whether this file needs a U1-ify transplant" style="font-size:11px;padding:3px 8px">🔍</button>' +
      '<button class="btn ghost slc-orca" data-f="' + esc(f.file) + '" title="Open in Snapmaker Orca for toolhead painting" style="font-size:11px;padding:3px 8px">🎨 Orca</button>' +
      '<button class="btn ghost slc-go" data-f="' + esc(f.file) + '" style="font-size:11px;padding:3px 8px"' + (st.exeFound ? "" : " disabled") + ">Slice</button></div></div>"
    ).join("");
    h += "</div>";

    // Active "waiting for gcode" Orca sessions
    if (ORCA_SESSIONS.size > 0) {
      h += '<div class="card" style="padding:12px 14px;margin-bottom:10px"><div style="font-weight:600;margin-bottom:6px">&#127752; Open in Orca</div>';
      for (const [sid, sess] of ORCA_SESSIONS) {
        if (sess.state === "done") {
          const dispatchOn = !!(window.HubModules && HubModules.fileAction && HubModules.fileAction());
          h += '<div style="padding:5px 0;font-size:13px">&#10003; <b>' + esc(sess.newGcode) + '</b> saved' +
            (dispatchOn ? ' <button class="btn slc-orca-disp" data-g="' + esc(sess.newGcode) + '" data-t="u1" data-sid="' + sid + '" style="font-size:12px;padding:3px 12px;margin-left:8px">&#128203; Queue in Dispatch</button>' : '') + '</div>';
        } else {
          h += '<div style="padding:5px 0;font-size:13px;opacity:.8">&#9201; Waiting for ' + esc(sess.file) + ' to be saved from Orca&hellip; <span style="font-size:11px;opacity:.6">' + Math.round((Date.now() - sess.launchedAt) / 60000) + 'm</span></div>';
        }
      }
      h += '</div>';
    }
    h += '<div class="card" style="padding:12px 14px"><div style="display:flex;align-items:center;margin-bottom:6px"><div style="font-weight:600;flex:1">Slice jobs</div>' +
      (jobs.some(x => x.state === "done" || x.state === "error") ? '<button class="btn ghost" id="slc-clear" style="font-size:11px;padding:2px 9px">Clear finished</button>' : "") + "</div>";
    if (!jobs.length) h += '<div style="font-size:13px;opacity:.7">Nothing yet. Jobs reset on Hub restart; finished gcode stays in the G-code folder.</div>';
    h += jobs.map(j => {
      const badge = { queued: "⏳ queued", preparing: "🧬 preparing", slicing: "⚙ slicing", moving: "📦 moving", done: "✓ done", error: "✗ failed" }[j.state] || j.state;
      const col = j.state === "done" ? "#3fae6a" : j.state === "error" ? "#d05050" : "inherit";
      let b = '<div style="padding:7px 0;border-bottom:1px solid rgba(128,128,128,.12)">' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<b style="color:' + col + '">' + badge + "</b>" +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(j.file) + "</span>" +
        ((j.copies || 1) > 1 ? '<span style="font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:1px 7px">×' + j.copies + "</span>" : "") +
        Object.entries(j.settings || {}).map(([k, v]) =>
          '<span style="font-size:11px;opacity:.7;border:1px solid rgba(128,128,128,.3);border-radius:8px;padding:1px 6px">' + esc(k.replace(/_/g, " ")) + " " + esc(v) + "</span>").join("") +
        (j.transplanted ? '<span title="' + esc((j.changed || []).join("\n")) + '" style="font-size:11px;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:1px 7px">🧬 U1-ified</span>' : "") +
        "</div>";
      const misses = Object.entries(j.applied || {}).filter(([, a]) => !a.ok);
      if (misses.length)
        b += '<div style="font-size:12px;color:#e0a020;margin-top:3px">⚠ slicer ignored: ' +
          misses.map(([k, a]) => esc(k) + " (asked " + esc(a.requested) + ", gcode says " + esc(a.applied == null ? "nothing" : a.applied) + ")").join("; ") + "</div>";
      if (j.state === "done") {
        const names = (j.gcodeNames && j.gcodeNames.length ? j.gcodeNames : [j.gcodeName]);
        if ((j.plates || 1) > 1)
          b += '<div style="font-size:12px;color:#e0a020;margin-top:3px">⚠ Not everything fits one bed — arrange split this across ' + j.plates + ' plates. Each is its own print:</div>';
        for (const nm of names)
          b += '<div style="font-size:12px;margin-top:3px">→ <code>' + esc(nm) + "</code>" +
            (nm === names[0] && j.estMinutes != null ? " · est " + fmtMin(j.estMinutes) : "") +
            (dispatchOn ? ' <button class="btn ghost slc-disp" data-g="' + esc(nm) + '" data-t="' + esc(j.type) + '" style="font-size:11px;padding:2px 9px;margin-left:6px">📋 Queue in Dispatch</button>' : "") + "</div>";
      }
      if (j.state === "done" || j.state === "error")
        b = b.replace("</div>", ' <button class="btn ghost slc-again" data-id="' + j.id + '" title="Slice again with the same options" style="font-size:11px;padding:1px 8px">↻</button></div>');
      if (j.state === "error")
        b += '<div style="font-size:12px;color:#d05050;margin-top:3px">' + esc(j.error) + "</div>" +
          (j.hint ? '<div style="font-size:12px;opacity:.75;margin-top:2px">💡 ' + esc(j.hint) + "</div>" : "");
      if ((j.detectedReasons || []).length && j.state !== "done")
        b += '<div style="font-size:11px;opacity:.6;margin-top:2px">detected: ' + esc(j.detectedReasons.join("; ")) + "</div>";
      if (j.logTail && (j.state === "error" || j.state === "slicing"))
        b += '<details style="margin-top:3px"><summary style="font-size:11px;opacity:.6;cursor:pointer">log tail</summary>' +
          '<pre style="font-size:10px;max-height:160px;overflow:auto;white-space:pre-wrap">' + esc(j.logTail) + "</pre></details>";
      return b + "</div>";
    }).join("");
    h += "</div>";

    EL.innerHTML = h;
    const cfgBox = EL.querySelector("#slc-cfg");
    if (CFG_OPEN && cfgBox) cfgBox.style.display = "";
    const tgl = EL.querySelector("#slc-cfg-toggle");
    if (tgl) tgl.addEventListener("click", () => { CFG_OPEN = !CFG_OPEN; cfgBox.style.display = CFG_OPEN ? "" : "none"; });
    const sv = EL.querySelector("#slc-cfg-save");
    if (sv) sv.addEventListener("click", async () => {
      sv.disabled = true;
      const msg = EL.querySelector("#slc-cfg-msg");
      const r2 = await jpost("/api/slice/config", {
        srcFolder: EL.querySelector("#slc-cfg-src").value,
        exe: EL.querySelector("#slc-cfg-exe").value
      });
      if (r2.status === 200) {
        msg.textContent = "saved" +
          (r2.body.srcFolderFound ? "" : " — folder not found (yet)") +
          (r2.body.exeFound ? "" : " — exe not found");
        CFG_OPEN = false;
        setTimeout(refresh, 600);
      } else { msg.textContent = (r2.body && r2.body.error) || "save failed"; sv.disabled = false; }
    });
    EL.querySelectorAll(".slc-go").forEach(btn => btn.addEventListener("click", () => {
      // Toggle an inline options row under the file. Blank knob = keep the
      // 3MF's own value; only touched knobs go to the CLI.
      const row = btn.closest("div");
      const open = row.nextElementSibling && row.nextElementSibling.classList.contains("slc-opts");
      EL.querySelectorAll(".slc-opts").forEach(x => x.remove());
      if (open) return;
      const o = document.createElement("div");
      o.className = "slc-opts";
      o.style.cssText = "padding:8px 10px;margin:2px 0 6px;border:1px solid rgba(128,128,128,.25);border-radius:8px;font-size:12px";
      o.innerHTML =
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<label>Copies <span style="display:inline-flex;align-items:center;gap:4px">' +
          '<button class="btn ghost so-dec" style="padding:1px 8px">−</button>' +
          '<b class="so-copies" style="min-width:18px;text-align:center">1</b>' +
          '<button class="btn ghost so-inc" style="padding:1px 8px">+</button></span></label>' +
        '<label>Layer <select class="so-lh"><option value="">3MF default</option>' +
          ["0.08","0.12","0.16","0.2","0.24","0.28"].map(v => '<option value="' + v + '">' + v + ' mm</option>').join("") + "</select></label>" +
        '<label>Infill <input class="so-inf" type="number" min="0" max="100" step="5" placeholder="—" style="width:52px"> %</label>' +
        '<label>Walls <input class="so-walls" type="number" min="1" max="12" step="1" placeholder="—" style="width:44px"></label>' +
        '<label><input class="so-sup" type="checkbox"> Supports</label>' +
        '<button class="btn ghost so-more" style="font-size:11px;padding:2px 8px">More ▾</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn so-run" style="font-size:12px;padding:4px 14px">Slice</button></div>' +
        '<div class="so-adv" style="display:none;gap:10px;flex-wrap:wrap;align-items:center;margin-top:7px">' +
        '<label>Pattern <select class="so-pat"><option value="">3MF default</option>' +
          ["grid","gyroid","cubic","honeycomb","lightning","zig-zag","triangles","adaptivecubic"].map(v => '<option>' + v + "</option>").join("") + "</select></label>" +
        '<label>Brim <select class="so-brim"><option value="">3MF default</option>' +
          ["no_brim","outer_only","inner_only","outer_and_inner","auto_brim"].map(v => '<option>' + v + "</option>").join("") + "</select></label>" +
        '<label>Top <input class="so-top" type="number" min="0" max="20" placeholder="—" style="width:44px"></label>' +
        '<label>Bottom <input class="so-bot" type="number" min="0" max="20" placeholder="—" style="width:44px"></label></div>' +
        '<div class="so-note" style="opacity:.55;margin-top:4px">Copies &gt; 1 auto-arranges the plate. Supports unchecked = 3MF default.</div>';
      row.after(o);
      let copies = 1;
      const cEl = o.querySelector(".so-copies");
      o.querySelector(".so-dec").addEventListener("click", () => { copies = Math.max(1, copies - 1); cEl.textContent = copies; });
      o.querySelector(".so-inc").addEventListener("click", () => { copies = Math.min(50, copies + 1); cEl.textContent = copies; });
      o.querySelector(".so-more").addEventListener("click", () => {
        const a = o.querySelector(".so-adv");
        a.style.display = a.style.display === "none" ? "flex" : "none";
      });
      o.querySelector(".so-run").addEventListener("click", async () => {
        const s = {};
        const lh = o.querySelector(".so-lh").value; if (lh) s.layer_height = lh;
        const inf = o.querySelector(".so-inf").value; if (inf !== "") s.sparse_infill_density = inf;
        const wl = o.querySelector(".so-walls").value; if (wl !== "") s.wall_loops = wl;
        if (o.querySelector(".so-sup").checked) s.enable_support = true;
        const pat = o.querySelector(".so-pat").value; if (pat) s.sparse_infill_pattern = pat;
        const br = o.querySelector(".so-brim").value; if (br) s.brim_type = br;
        const tp = o.querySelector(".so-top").value; if (tp !== "") s.top_shell_layers = tp;
        const bt = o.querySelector(".so-bot").value; if (bt !== "") s.bottom_shell_layers = bt;
        const rb = o.querySelector(".so-run"); rb.disabled = true; rb.textContent = "…";
        const r = await jpost("/api/slice", { file: btn.dataset.f, type: "u1", transplant: "auto", copies, settings: s });
        if (r.status !== 200) { rb.textContent = "failed"; rb.title = (r.body && r.body.error) || ""; setTimeout(() => { rb.textContent = "Slice"; rb.disabled = false; }, 1800); }
        else { o.remove(); refresh(); }
      });
    }));
    EL.querySelectorAll(".slc-insp").forEach(btn => btn.addEventListener("click", async () => {
      const r = await jget("/api/slice/inspect?file=" + encodeURIComponent(btn.dataset.f));
      if (r.status !== 200) { btn.title = "inspect failed"; return; }
      const row = btn.closest("div");
      const oldNote = row.parentNode.querySelector(".slc-inspnote"); if (oldNote) oldNote.remove();
      const n = document.createElement("div");
      n.className = "slc-inspnote";
      n.style.cssText = "font-size:12px;padding:4px 10px;margin:2px 0 4px;opacity:.85";
      n.innerHTML = r.body.native
        ? '<span style="color:#3fae6a">✓ Native U1 project — slices as-is.</span>'
        : '<span style="color:#e0a020">🧬 Will be U1-ified:</span> ' + r.body.reasons.map(esc).join("; ");
      row.after(n);
      setTimeout(() => n.remove(), 12000);
    }));
    EL.querySelectorAll(".slc-orca").forEach(btn => btn.addEventListener("click", async () => {
      const oldTxt = btn.textContent; btn.disabled = true; btn.textContent = "launching…";
      const r = await jpost("/api/slice/open-in-orca", { file: btn.dataset.f, type: "u1" });
      if (r.status !== 200) {
        btn.textContent = "failed"; btn.title = (r.body && r.body.error) || "";
        setTimeout(() => { btn.textContent = oldTxt; btn.disabled = false; }, 2000);
      } else {
        ORCA_SESSIONS.set(r.body.sessionId, { state: "watching", file: r.body.file, newGcode: null, launchedAt: Date.now() });
        btn.textContent = oldTxt; btn.disabled = false; refresh();
      }
    }));
    EL.querySelectorAll(".slc-orca-disp").forEach(btn => btn.addEventListener("click", async () => {
      const fa = HubModules.fileAction(); if (!fa) return;
      const oldTxt = btn.textContent;
      try { await fa.run(btn.dataset.g, btn.dataset.t); btn.textContent = "✓ sent"; ORCA_SESSIONS.delete(+btn.dataset.sid); setTimeout(refresh, 400); }
      catch { btn.textContent = "failed"; setTimeout(() => { btn.textContent = oldTxt; }, 1500); }
    }));
    const clr = EL.querySelector("#slc-clear");
    if (clr) clr.addEventListener("click", async () => { await jpost("/api/slice/clear"); refresh(); });
    EL.querySelectorAll(".slc-again").forEach(btn => btn.addEventListener("click", async () => {
      btn.disabled = true;
      await jpost("/api/slice/again", { id: +btn.dataset.id });
      refresh();
    }));
    EL.querySelectorAll(".slc-disp").forEach(btn => btn.addEventListener("click", async () => {
      const fa = HubModules.fileAction(); if (!fa) return;
      const old = btn.textContent;
      try { await fa.run(btn.dataset.g, btn.dataset.t); btn.textContent = "✓ sent"; }
      catch (e) { btn.textContent = "failed"; }
      setTimeout(() => { btn.textContent = old; }, 1200);
    }));
  }

  HubModules.register("slicing", {
    tab: "Slice",
    mount(el) { EL = el; },
    onShow() {
      refresh();
      clearInterval(TIMER);
      // 4s poll only while the tab is visible; state changes are seconds-scale.
      TIMER = setInterval(() => { if (EL && EL.style.display !== "none") refresh(); else clearInterval(TIMER); }, 4000);
    }
  });
})();
