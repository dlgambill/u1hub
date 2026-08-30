// public/modules/dispatch-ui.js — Dispatch timeline UI (v2.11). Injected only
// when features.dispatch is on; mounted through HubModules. Starting a job
// ALWAYS goes through the existing /api/print path from this client after the
// human bed-clear tap — dispatch never grows its own way to start a machine.
//
// v2.11 UI round 2 (Danny's direction):
//   * drag a file straight from the library list onto the Dispatch tab or
//     view — the core marks rows draggable with an application/x-u1hub-file
//     payload; hovering the tab switches to it mid-drag.
//   * attended hours are a WEEK: pick a calendar week, tick the days you're
//     around, set each day's hours. "Every week" writes the template;
//     "this week only" writes an override the scheduler prefers.
//   * multi-plate prints: add several gcode files as ONE bundle — members
//     share the bundle's deadline and quantity, and the jobs list shows them
//     grouped under it.
//
// v2.13 — COMPLETION TARGET. One "finish everything by" datetime for the whole
// queue (the shape a show or a pickup actually has), plus the feasibility
// report the server builds from the same slots the timeline draws: what makes
// it, what doesn't, why not, and what recovering that wait would buy. The
// prose lives on the server so the report and the plan can never disagree;
// this file only lays it out.

"use strict";
(function () {
  let STATE = null, PLAN = null, EL = null;
  let FILEQ = [];                                  // files staged for Add (chips)
  let REPOPEN = false;                             // feasibility detail expanded?
  // Short labels for the server's cause codes. The server owns the sentence;
  // this is only the chip on the row, so the two can never drift apart in
  // meaning — if a code arrives that isn't here, the raw code shows.
  const CAUSE = {
    too_long:       "longer than the time left",
    queued_behind:  "queued behind other copies",
    bed_clear:      "waiting for a bed clear",
    printer_busy:   "printer still running",
    attended_hours: "outside attended hours",
    no_slack:       "no slack left",
    unplannable:    "can't be planned"
  };
  const DAYK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const DAYLBL = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
  const $$ = sel => EL.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtT = ms => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const fmtMin = m => m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? (m % 60) + "m" : "") : m + "m";
  function isoWeekKey(ms) {
    const dt = new Date(ms); dt.setHours(0, 0, 0, 0);
    dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
    const j4 = new Date(dt.getFullYear(), 0, 4);
    const wk = 1 + Math.round(((dt - j4) / 86400000 - 3 + ((j4.getDay() + 6) % 7)) / 7);
    return dt.getFullYear() + "-W" + String(wk).padStart(2, "0");
  }
  async function jget(p) { const r = await fetch(p); return { ok: r.ok, body: await r.json().catch(() => null) }; }
  async function jpost(p, b) {
    const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
    return { ok: r.ok, body: await r.json().catch(() => null) };
  }

  async function load() {
    const [d, p] = await Promise.all([jget("/api/dispatch"), jget("/api/dispatch/plan")]);
    STATE = d.body || { jobs: [], bundles: [], settings: {} };
    PLAN = p.body || { slots: [] };
    render();
  }

  function render() { if (!STATE) return; renderWeek(); renderTarget(); renderChips(); renderJobs(); renderReport(); renderPlan(); }

  // ---- farm completion target + feasibility report (v2.13) -----------------
  // "Everything done by Friday 5pm." One datetime for the whole queue, because
  // that is the shape a show or a customer pickup actually has. The server
  // treats it as a FALLBACK deadline (a job's own deadline still wins) and
  // hands back a report; this half only has to say it plainly.
  const dtLocal = ms => {                        // ms -> value for <input type=datetime-local>
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  };
  function renderTarget() {
    const t = (STATE.settings || {}).target || null;
    const inp = $$("#dsp-target");
    if (inp && document.activeElement !== inp) inp.value = t ? dtLocal(t) : "";
    $$("#dsp-target-clear").style.display = t ? "" : "none";
  }
  function renderReport() {
    const box = $$("#dsp-report");
    const rep = PLAN && PLAN.report;
    if (!rep || !rep.copies) { box.innerHTML = ""; return; }
    // No target and no per-job deadlines: nothing to be late against. Say so
    // rather than showing a green banner that means nothing.
    if (!rep.judged) {
      box.innerHTML = `<div class="dsp-rep dsp-rep-none">No completion target set — set one above and this becomes "what makes it, and what doesn't".</div>`;
      return;
    }
    const n = rep.misses, judged = rep.judged;
    const head = n === 0
      ? `<b>✓ All ${judged} cop${judged === 1 ? "y" : "ies"} make their deadline.</b>` +
        (rep.slack_min != null ? ` <span>Tightest margin ${fmtMin(rep.slack_min)}${rep.latest_end ? " · plan ends " + fmtT(rep.latest_end) : ""}.</span>` : "")
      : `<b>⚠ ${n} of ${judged} copies miss.</b> <span>${rep.makes} make it${rep.latest_end ? " · plan ends " + fmtT(rep.latest_end) : ""}.</span>`;
    const rows = (rep.items || []).map(it => `
      <div class="dsp-repitem">
        <div class="dsp-repline">
          <span class="dsp-repfile">${esc(it.file.replace(/\.gcode$/i, ""))}${it.of > 1 ? ` <i>#${it.copy}/${it.of}</i>` : ""}</span>
          <span class="dsp-replate">${it.late_min == null ? "unplannable" : fmtMin(it.late_min) + " late"}</span>
          <span class="dsp-repwhere">${it.printerName ? esc(it.printerName) + " · lands " + fmtT(it.est_end) : ""}</span>
          <span class="dsp-repcause">${esc(CAUSE[it.cause] || it.cause)}</span>
        </div>
        <div class="dsp-repwhy">${esc(it.cause_detail)}</div>
        <div class="dsp-repfix">→ ${esc(it.fix)}</div>
        ${it.contention ? `<div class="dsp-repnote">⚠ ${esc(it.contention)}</div>` : ""}
      </div>`).join("");
    box.innerHTML =
      `<div class="dsp-rep ${n ? "dsp-rep-bad" : "dsp-rep-ok"}">${head}` +
      (n ? `<button id="dsp-rep-toggle" class="dsp-repmore">${REPOPEN ? "hide" : "why?"}</button>` : "") +
      `</div>` + (n && REPOPEN ? `<div class="dsp-replist">${rows}</div>` : "");
    const tg = $$("#dsp-rep-toggle");
    if (tg) tg.onclick = () => { REPOPEN = !REPOPEN; renderReport(); };
  }

  // ---- attended hours: calendar-week editor ---------------------------------
  function selectedWeekKey() { return $$("#dsp-week").value || isoWeekKey(Date.now()); }
  function renderWeek() {
    const wkInput = $$("#dsp-week");
    if (!wkInput.value) wkInput.value = isoWeekKey(Date.now());
    const key = selectedWeekKey();
    const tpl = (STATE.settings || {}).week || {};
    const ov = ((STATE.settings || {}).weekOverrides || {})[key] || {};
    $$("#dsp-days").innerHTML = DAYK.map(k => {
      const d = ov[k] || tpl[k] || { on: false };
      const wins = winsOf(d);
      return `<div class="dsp-day${ov[k] ? " dsp-ov" : ""}" data-day="${k}">
        <label><input type="checkbox" data-don ${d.on !== false ? "checked" : ""}> ${DAYLBL[k]}${ov[k] ? " •" : ""}</label>
        <div class="dsp-wins">${wins.map(w => winRow(w, d.on !== false)).join("")}</div>
        <button class="dsp-addwin" data-addwin>+ block</button>
      </div>`;
    }).join("");
    $$("#dsp-days").querySelectorAll("[data-don]").forEach(cb => cb.onchange = () => {
      const row = cb.closest(".dsp-day");
      row.querySelectorAll("input[type=time]").forEach(t => t.disabled = !cb.checked);
      row.querySelector("[data-addwin]").disabled = !cb.checked;
    });
    $$("#dsp-days").querySelectorAll("[data-addwin]").forEach(b => b.onclick = () => {
      const wrap = b.previousElementSibling;
      wrap.insertAdjacentHTML("beforeend", winRow({ start: "17:00", end: "22:00" }, true));
      bindWinRemove(wrap);
    });
    $$("#dsp-days").querySelectorAll(".dsp-wins").forEach(bindWinRemove);
    $$("#dsp-clearov").style.display = Object.keys(ov).length ? "" : "none";
    $$("#dsp-policy").value = (STATE.settings || {}).finish_policy || "anytime";
    $$("#dsp-hours-sum").textContent = hoursSummary();
  }
  // A day is a list of windows; legacy {start,end} days read as one window.
  function winsOf(d) {
    if (!d) return [{ start: "08:00", end: "22:00" }];
    if (Array.isArray(d.windows) && d.windows.length) return d.windows;
    if (d.start && d.end) return [{ start: d.start, end: d.end }];
    return [{ start: "08:00", end: "22:00" }];
  }
  function winRow(w, enabled) {
    return `<div class="dsp-win"><input type="time" data-ws value="${esc(w.start)}" ${enabled ? "" : "disabled"}>–<input type="time" data-we value="${esc(w.end)}" ${enabled ? "" : "disabled"}><b data-rmwin title="remove this block">✕</b></div>`;
  }
  function bindWinRemove(wrap) {
    wrap.querySelectorAll("[data-rmwin]").forEach(x => x.onclick = () => {
      if (wrap.querySelectorAll(".dsp-win").length > 1) x.closest(".dsp-win").remove();
    });
  }
  function readDays() {
    const days = {};
    $$("#dsp-days").querySelectorAll(".dsp-day").forEach(row => {
      const windows = [...row.querySelectorAll(".dsp-win")].map(w => ({
        start: w.querySelector("[data-ws]").value || "08:00",
        end: w.querySelector("[data-we]").value || "22:00"
      })).filter(w => w.start < w.end);
      days[row.dataset.day] = { on: row.querySelector("[data-don]").checked, windows };
    });
    return days;
  }
  // One-line summary for the collapsed bar: groups identical days.
  function hoursSummary() {
    const tpl = (STATE.settings || {}).week || {};
    const fmt12 = t => { const [h, m] = String(t).split(":").map(Number);
      const ap = h >= 12 ? "p" : "a", hh = h % 12 || 12; return hh + (m ? ":" + String(m).padStart(2, "0") : "") + ap; };
    const sig = k => { const d = tpl[k]; if (!d || d.on === false) return "off";
      return winsOf(d).map(w => fmt12(w.start) + "-" + fmt12(w.end)).join(", "); };
    const parts = []; let i = 0;
    while (i < 7) {
      let j = i; while (j + 1 < 7 && sig(DAYK[j + 1]) === sig(DAYK[i])) j++;
      const label = i === j ? DAYLBL[DAYK[i]] : DAYLBL[DAYK[i]] + "–" + DAYLBL[DAYK[j]];
      parts.push(label + " " + sig(DAYK[i])); i = j + 1;
    }
    const ovCount = Object.keys((STATE.settings || {}).weekOverrides || {}).length;
    return parts.join(" · ") + (ovCount ? "  (" + ovCount + " week override" + (ovCount > 1 ? "s" : "") + ")" : "");
  }

  // ---- add-job chips (dropdown, drag-drop, multi-file bundles) --------------
  // Each staged file carries its OWN quantity — "2 butter clickers, 1 stego"
  // is one add. Dragging the same file again bumps its count instead of
  // silently doing nothing.
  function addChip(file, type) {
    if (!file) return;
    const hit = FILEQ.find(x => x.file === file);
    if (hit) { hit.qty = Math.min(999, (hit.qty || 1) + 1); flash(file); }
    else FILEQ.push({ file, qty: 1, type: type || ((typeof activeType === "function" && activeType().slug) || "u1") });
    renderChips();
  }
  function flash(file) {
    setTimeout(() => {
      const el = EL && EL.querySelector('[data-chipfile="' + CSS.escape(file) + '"]');
      if (el) { el.classList.add("dsp-bump"); setTimeout(() => el.classList.remove("dsp-bump"), 400); }
    }, 0);
  }
  function renderChips() {
    if (!EL) return;                       // staged before the view mounted
    const box = $$("#dsp-chips");
    box.innerHTML = FILEQ.length ? FILEQ.map((x, i) =>
      `<span class="dsp-chip" data-chipfile="${esc(x.file)}">
         <span class="dsp-cname">${esc(x.file.replace(/\.gcode$/i, ""))}</span>
         <button class="dsp-q" data-qm="${i}" title="one fewer">−</button>
         <input class="dsp-qty" data-qn="${i}" type="number" min="1" max="999" value="${x.qty || 1}">
         <button class="dsp-q" data-qp="${i}" title="one more">+</button>
         <b data-chipx="${i}" title="remove">✕</b></span>`).join("")
      : '<span class="dsp-hinttext">Drop g-code files anywhere on this tab, or pick one above and press <b>+ add file</b>.</span>';
    box.querySelectorAll("[data-chipx]").forEach(b => b.onclick = () => { FILEQ.splice(+b.dataset.chipx, 1); renderChips(); });
    box.querySelectorAll("[data-qp]").forEach(b => b.onclick = () => { const x = FILEQ[+b.dataset.qp]; x.qty = Math.min(999, (x.qty || 1) + 1); renderChips(); });
    box.querySelectorAll("[data-qm]").forEach(b => b.onclick = () => { const x = FILEQ[+b.dataset.qm]; x.qty = Math.max(1, (x.qty || 1) - 1); renderChips(); });
    box.querySelectorAll("[data-qn]").forEach(inp => inp.onchange = () => { const x = FILEQ[+inp.dataset.qn]; x.qty = Math.max(1, Math.min(999, parseInt(inp.value, 10) || 1)); renderChips(); });
    const total = FILEQ.reduce((n, x) => n + (x.qty || 1), 0);
    $$("#dsp-bundlename").style.display = FILEQ.length > 1 ? "" : "none";
    $$("#dsp-add").textContent = FILEQ.length > 1
      ? "Add " + FILEQ.length + " files as one bundle (" + total + " prints)"
      : (FILEQ.length ? "Add" + (total > 1 ? " \u00d7" + total : "") : "Add");
  }

  // ---- jobs list, bundles grouped -------------------------------------------
  function renderJobs() {
    const box = $$("#dsp-jobs");
    const jobs = STATE.jobs || [], bundles = STATE.bundles || [];
    // Summary for the collapsed bar — set every render so it never goes stale.
    const sum = $$("#dsp-jobs-sum");
    if (sum) {
      const act = jobs.filter(j => j.state !== "done");
      const printing = act.filter(j => j.state === "printing").length;
      const paused = act.filter(j => j.state === "paused").length;
      const left = act.reduce((n, j) => n + (j.remaining || 0), 0);
      sum.textContent = act.length
        ? `— ${act.length} job${act.length === 1 ? "" : "s"} · ${left} cop${left === 1 ? "y" : "ies"} left${printing ? " · ▶ " + printing : ""}${paused ? " · ⏸ " + paused : ""}`
        : "— none";
    }
    if (!jobs.length) { box.innerHTML = '<div class="dsp-empty">No jobs yet — drag a file in or add one above.</div>'; return; }
    const jobRow = j => {
      const dl = j.deadline ? fmtT(j.deadline) : (j.bundle_id ? "↑ bundle" : "—");
      const st = { queued: "queued", scheduled: "planned", printing: "▶ printing", done: "✓ done", paused: "⏸ paused" }[j.state] || j.state;
      return `<div class="dsp-job dsp-${esc(j.state)}${j.bundle_id ? " dsp-inbundle" : ""}">
        <span class="dsp-jfile">${esc(j.file)}</span><span>${j.remaining}/${j.qty}</span>
        <span title="deadline">${esc(dl)}</span>
        <span>${j.est_minutes ? fmtMin(j.est_minutes) + "/ea" : "est ?"}</span>
        <span class="dsp-swatches">${(j.colors || []).map(c => `<i style="background:#${esc(String(c).replace(/^#/, ""))}"></i>`).join("")}</span>
        <span class="dsp-jstate">${esc(st)}</span>
        <button data-dsp-pause="${esc(j.id)}">${j.state === "paused" ? "Resume" : "Pause"}</button>
        ${j.printing_on != null ? `<button data-dsp-rel="${esc(j.id)}" title="This job is attached to a printer. Release it if that's wrong (printer re-addressed, swapped, or claimed by mistake) so it can be re-matched.">\u26d3 release</button>` : ""}
        <button data-dsp-del="${esc(j.id)}">✕</button></div>`;
    };
    const inBundle = new Set();
    let html = "";
    for (const b of bundles) {
      const members = jobs.filter(j => j.bundle_id === b.id);
      if (!members.length) continue;
      members.forEach(j => inBundle.add(j.id));
      html += `<div class="dsp-bundle"><div class="dsp-bhead">📦 ${esc(b.name)}
        <span>${b.deadline ? "due " + fmtT(b.deadline) : ""}</span>
        <button data-dsp-bdel="${esc(b.id)}" title="Remove bundle and its jobs">✕</button></div>
        ${members.map(jobRow).join("")}</div>`;
    }
    html += jobs.filter(j => !inBundle.has(j.id)).map(jobRow).join("");
    box.innerHTML = html;
    box.querySelectorAll("[data-dsp-del]").forEach(b => b.onclick = async () => { await jpost("/api/dispatch/jobs/remove", { id: b.dataset.dspDel }); load(); });
    box.querySelectorAll("[data-dsp-bdel]").forEach(b => b.onclick = async () => {
      const id = b.dataset.dspBdel;
      for (const j of (STATE.jobs || []).filter(x => x.bundle_id === id)) await jpost("/api/dispatch/jobs/remove", { id: j.id });
      await jpost("/api/dispatch/bundles/remove", { id }); load();
    });
    box.querySelectorAll("[data-dsp-rel]").forEach(b => b.onclick = async () => {
      await jpost("/api/dispatch/jobs/release", { id: b.dataset.dspRel });
      await jpost("/api/dispatch/adopt", {});      // let it re-match against reality
      load();
    });
    box.querySelectorAll("[data-dsp-pause]").forEach(b => b.onclick = async () => {
      const j = (STATE.jobs || []).find(x => x.id === b.dataset.dspPause);
      await jpost("/api/dispatch/jobs/update", { id: j.id, state: j.state === "paused" ? "queued" : "paused" }); load();
    });
  }

  // ---- plan lanes -----------------------------------------------------------
  function renderPlan() {
    const box = $$("#dsp-plan");
    const slots = (PLAN && PLAN.slots) || [];
    const bad = slots.filter(s => s.unplannable);
    const good = slots.filter(s => !s.unplannable);
    if (!good.length && !bad.length && !((PLAN && PLAN.printers) || []).length) { box.innerHTML = '<div class="dsp-empty">Nothing planned.</div>'; return; }
    const byPrinter = {};
    // Seed every online printer so idle ones still get a lane (visible unused
    // capacity beats a tidy-looking plan).
    for (const p of (PLAN && PLAN.printers) || []) byPrinter[p.idx] = { name: p.name, slots: [] };
    for (const s of good) (byPrinter[s.printer] = byPrinter[s.printer] || { name: s.printerName, slots: [] }).slots.push(s);
    const t0 = good.length ? Math.min(...good.map(s => s.est_start), Date.now()) : Date.now();
    const t1 = good.length ? Math.max(...good.map(s => s.est_end), t0 + 3600000) : t0 + 3600000;
    const span = t1 - t0;
    const pct = ms => Math.max(0, Math.min(100, ((ms - t0) / span) * 100));
    const awaiting = new Set(STATE.awaiting || []);
    box.innerHTML = Object.entries(byPrinter).map(([idx, lane]) => {
      const blocks = lane.slots.map(s => {
        const l = pct(s.est_start), w = Math.max(2, pct(s.est_end) - l);
        const cls = s.misses_deadline ? " dsp-miss" : "";
        const swapBadge = s.swaps.length ? `<b class="dsp-swapn" title="${esc(s.swaps.map(x => (x.spool ? x.spool + " (" + x.color + ")" : x.color)).join("\n"))}">${s.swaps.length}⇄</b>` : "";
        return `<div class="dsp-blk${cls}" data-slot="${good.indexOf(s)}" style="left:${l}%;width:${w}%" title="${esc(s.file)} #${s.copy}/${s.of}\n${fmtT(s.est_start)} → ${fmtT(s.est_end)}${s.est_assumed ? "\n(no estimate in file — 1 h assumed)" : ""}${s.misses_deadline ? "\n⚠ MISSES DEADLINE" : ""}">${esc(s.file.replace(/\.gcode$/, ""))} ${swapBadge}${s.contention ? `<b class="dsp-clash" title="${esc(s.contention.color)} also needed by ${esc(s.contention.file)} on ${esc(s.contention.printer)}">\u26a0</b>` : ""}${s.idle_after_min ? `<b class="dsp-idle" title="machine waits for you to clear the bed">\u{1F4A4}${Math.round(s.idle_after_min / 60)}h</b>` : ""}</div>`;
      }).join("");
      const clearBtn = awaiting.has(+idx)
        ? `<button class="dsp-clear" data-dsp-clear="${idx}">Bed cleared → start next</button>`
        : `<button class="dsp-clear dsp-idleclear" data-dsp-clear="${idx}" title="Hand this printer its next planned job now">▶ start next</button>`;
      const idleNote = lane.slots.length ? "" : '<span class="dsp-lidle">idle — no work planned</span>';
      return `<div class="dsp-lane"><div class="dsp-lname">${esc(lane.name)} ${clearBtn} ${idleNote}</div><div class="dsp-track">${blocks}</div></div>`;
    }).join("") + (bad.length ? `<div class="dsp-empty">⚠ ${bad.length} cop${bad.length === 1 ? "y" : "ies"} unplannable: ${esc(bad[0].unplannable)}</div>` : "");
    box.querySelectorAll("[data-dsp-clear]").forEach(b => b.onclick = () => clearBed(+b.dataset.dspClear, b));
    // Touch has no hover, so the title attribute is invisible on a phone —
    // and short blocks truncate to "Ca...". Tapping opens the details.
    box.querySelectorAll("[data-slot]").forEach(b => b.onclick = () => showSlot(good[+b.dataset.slot]));
  }

  // Tap-to-expand: everything the cramped block couldn't say.
  function showSlot(s) {
    if (!s) return;
    const job = (STATE.jobs || []).find(j => j.id === s.job_id) || {};
    const dl = s.deadline ? fmtT(s.deadline) : "none";
    const rows = [
      ["Printer", s.printerName],
      ["Copy", s.copy + " of " + s.of],
      ["Start", fmtT(s.est_start)],
      ["Finish", fmtT(s.est_end) + (s.est_assumed ? "  (no estimate in file \u2014 1 h assumed)" : "")],
      ["Runtime", fmtMin(s.est_minutes)],
      ["Deadline", dl + (s.misses_deadline ? "   \u26a0 MISSES IT" : "")],
      s.idle_after_min ? ["Then idle", fmtMin(s.idle_after_min) + " waiting for a bed clear"] : null,
      s.contention ? ["\u26a0 Spool clash", s.contention.color + " is also needed by " + s.contention.file +
        " on " + s.contention.printer + " until " + fmtT(s.contention.until) + " \u2014 one roll can only be in one machine"] : null,
      s.pinned ? ["Assigned", "pinned to this printer"] : null,
      ["Colors", (job.colors || []).map(x => "#" + String(x).replace(/^#/, "")).join(" ") || "\u2014"]
    ].filter(Boolean);
    $$("#dsp-sheet").innerHTML = `
      <div class="dsp-sheetbox">
        <div class="dsp-sheettitle">${esc(s.file)}</div>
        <table class="dsp-sheettab">${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join("")}</table>
        ${s.swaps.length ? `<div class="dsp-sheetsub">Mount first <span class="dsp-anyslot">\u2014 any free tray, order doesn't matter</span></div><ul class="dsp-mounts">${s.swaps.map(x => `<li><i style="background:${esc(x.color)}"></i>${esc(x.spool ? x.spool + " (" + x.color + ")" : x.color)}${x.brand ? " \u00b7 " + esc(x.brand) : ""}</li>`).join("")}</ul>` : '<div class="dsp-sheetsub">No spool changes needed \u2713</div>'}
        <div class="dsp-sheetsub">Move this job</div>
        <div class="dsp-moverow">
          <select class="dsp-moveto">
            <option value="auto">auto \u2014 let the scheduler choose</option>
            ${((PLAN && PLAN.printers) || []).map(p => `<option value="${p.idx}" ${p.idx === s.printer ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
          <button class="dsp-movego" data-job="${esc(s.job_id)}">Move</button>
        </div>
        <button class="dsp-sheetclose">Close</button>
      </div>`;
    $$("#dsp-sheet").style.display = "flex";
    $$("#dsp-sheet").onclick = e => { if (e.target.id === "dsp-sheet" || e.target.classList.contains("dsp-sheetclose")) $$("#dsp-sheet").style.display = "none"; };
    const go = $$(".dsp-movego");
    if (go) go.onclick = async () => {
      const val = $$(".dsp-moveto").value;
      await jpost("/api/dispatch/jobs/assign", { id: go.dataset.job, printer: val === "auto" ? "auto" : +val });
      $$("#dsp-sheet").style.display = "none";
      load();
    };
  }

  async function clearBed(idx, btn) {
    btn.disabled = true;
    try {
      const r = await jpost("/api/dispatch/clear-bed", { printer: idx });
      const next = r.body && r.body.next;
      if (!next) { btn.textContent = "nothing planned"; setTimeout(load, 1200); return; }
      const mounts = next.swaps.length
        ? "\n\nMount first (any free tray \u2014 the order below doesn't matter,\nyou'll map tools to heads on the next screen):\n" +
          next.swaps.map(x => "  \u2022 " + (x.spool ? x.spool + " (" + x.color + ")" : x.color)).join("\n")
        : "";
      const warn = next.contention
        ? "\n\n\u26a0 " + next.contention.color + " is also needed by " + next.contention.file +
          " on " + next.contention.printer + " \u2014 you only have one roll unless you've bought more."
        : "";
      if (!confirm("Set up '" + next.file + "' (copy " + next.copy + "/" + next.of + ") on " +
                   next.printerName + mounts + warn +
                   "\n\nThe dashboard opens next so you can confirm the tool mapping before it starts."))
        { btn.disabled = false; return; }
      // Hand off to the dashboard's tool-head picker rather than starting
      // blind: Dispatch knows WHICH file goes WHERE, the dashboard owns the
      // mapping UI (and 2.10's duplicate-colour rules). Select the file, jump
      // to the dashboard, and let the human confirm heads and press send.
      if (typeof selectFile === "function") selectFile(next.file);
      setView("dash");
      setTimeout(() => {
        const card = document.querySelector('[data-printer-card="' + idx + '"]') ||
                     document.querySelectorAll(".pcard")[idx];
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 120);
    } finally { setTimeout(load, 800); }
  }

  // ---- mount ----------------------------------------------------------------
  function mount(el) {
    EL = el;
    el.innerHTML = `
    <style>
      .dsp-wrap{padding:6px 0}
      .dsp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
      .dsp-row input,.dsp-row select{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid #444;background:#1b1e24;color:inherit}
      .dsp-row button,.dsp-clear{font:inherit;font-size:13px;padding:6px 12px;border:1px solid #666;border-radius:6px;background:#23262d;color:inherit;cursor:pointer}
      .dsp-hoursbar{margin:6px 0}
      .dsp-toggle{font:inherit;font-size:12.5px;padding:6px 12px;border:1px solid #333;border-radius:8px;background:#1b1e24;color:#aab;cursor:pointer;text-align:left;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-toggle b{color:#d6a832}
      .dsp-days{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
      .dsp-wins{display:flex;flex-direction:column;gap:3px}
      .dsp-win{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
      .dsp-win b{cursor:pointer;color:#a55;font-size:13px;padding:4px 7px;line-height:1}
      .dsp-addwin{font:inherit;font-size:11px;padding:2px 7px;border:1px dashed #4a4f57;border-radius:5px;background:transparent;color:#889;cursor:pointer}
      .dsp-day{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid #2f333a;border-radius:8px;font-size:12px;flex:1 1 240px;min-width:0;max-width:340px}
      .dsp-day.dsp-ov{border-color:#d6a832}
      .dsp-day input[type=time]{font-size:12px;padding:4px 6px;border-radius:5px;border:1px solid #444;background:#1b1e24;color:inherit;width:auto;min-width:112px;flex:1 1 auto;box-sizing:content-box}
      .dsp-chipbox{min-height:56px;border:1px dashed #3a3f47;border-radius:8px;padding:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .dsp-chipbox.dsp-over{border-color:#4cd07a;background:#12281a}
      #dsp-drop{display:none;position:absolute;inset:0;z-index:9;align-items:center;justify-content:center;background:rgba(18,40,26,.82);border:2px dashed #4cd07a;border-radius:12px;pointer-events:none}
      #dsp-drop div{font-size:16px;font-weight:700;color:#4cd07a}
      .dsp-cname{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-q{font:inherit;font-size:13px;line-height:1;width:24px;height:24px;border:1px solid #4a4f57;border-radius:5px;background:#1b1e24;color:inherit;cursor:pointer;padding:0}
      .dsp-qty{width:46px;font:inherit;font-size:12.5px;padding:2px 4px;text-align:center;border:1px solid #444;border-radius:5px;background:#12151a;color:inherit}
      .dsp-bump{outline:2px solid #4cd07a}
      .dsp-chip{display:inline-flex;align-items:center;gap:5px;background:#23262d;border:1px solid #444;border-radius:14px;padding:4px 10px;font-size:12.5px}
      .dsp-chip b{margin-left:7px;cursor:pointer;color:#c66}
      .dsp-hinttext{color:#778;font-size:12px}
      .dsp-job{display:flex;gap:12px;align-items:center;padding:7px 10px;border-bottom:1px solid #2a2d33;font-size:13px;flex-wrap:wrap}
      .dsp-inbundle{padding-left:26px}
      .dsp-bundle{border:1px solid #34383f;border-radius:8px;margin:8px 0;overflow:hidden}
      .dsp-bhead{display:flex;gap:12px;align-items:center;background:#1e2127;padding:7px 10px;font-size:13px;font-weight:700}
      .dsp-bhead span{color:#9aa;font-weight:400}
      .dsp-bhead button{margin-left:auto}
      .dsp-jfile{font-weight:700;min-width:180px}
      .dsp-jstate{color:#9aa}
      .dsp-done{opacity:.55}
      .dsp-swatches i{display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid #0006;margin-right:2px;vertical-align:middle}
      .dsp-job button,.dsp-bhead button{font-size:12px;padding:3px 9px;border:1px solid #555;border-radius:5px;background:#23262d;color:inherit;cursor:pointer}
      .dsp-lane{margin:10px 0}
      .dsp-lname{font-size:13px;font-weight:700;margin-bottom:4px;display:flex;gap:10px;align-items:center}
      .dsp-clear{border-color:#0a7a33;color:#4cd07a;font-size:12px;padding:3px 10px}
      .dsp-idleclear{border-color:#555;color:#9aa}
      .dsp-track{position:relative;height:34px;background:#181b20;border:1px solid #2a2d33;border-radius:7px;overflow:hidden}
      .dsp-blk{position:absolute;top:3px;bottom:3px;background:#274a72;border:1px solid #3a6ca8;border-radius:5px;font-size:11px;line-height:26px;padding:0 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:default}
      .dsp-miss{background:#6e2020;border-color:#c0392b}
      .dsp-swapn{color:#ffd166;font-weight:700}
      .dsp-idle{color:#8ab;font-weight:700;margin-left:4px}
      .dsp-lidle{color:#667;font-weight:400;font-size:11.5px}
      #dsp-sheet{display:none;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.62);align-items:center;justify-content:center;padding:16px}
      .dsp-sheetbox{background:#161920;border:1px solid #343941;border-radius:12px;padding:16px;max-width:440px;width:100%;max-height:80vh;overflow:auto}
      .dsp-sheettitle{font-size:15px;font-weight:800;margin-bottom:10px;word-break:break-word}
      .dsp-sheettab{width:100%;font-size:13px;border-collapse:collapse}
      .dsp-sheettab td{padding:4px 0;vertical-align:top}
      .dsp-sheettab td:first-child{color:#889;width:96px}
      .dsp-sheetsub{margin:12px 0 4px;font-size:11.5px;letter-spacing:.07em;color:#d6a832;font-weight:800}
      .dsp-anyslot{color:#889;font-weight:400;letter-spacing:0;text-transform:none}
      .dsp-mounts{list-style:none;padding:0;margin:0;font-size:13px}
      .dsp-mounts li{display:flex;align-items:center;gap:8px;padding:3px 0}
      .dsp-mounts i{width:15px;height:15px;border-radius:4px;border:1px solid #0006;flex:none}
      .dsp-sheetclose{margin-top:14px;width:100%;font:inherit;font-size:13px;padding:9px;border:1px solid #555;border-radius:8px;background:#23262d;color:inherit;cursor:pointer}
      .dsp-blk{cursor:pointer}
      .dsp-clash{color:#ff9f43;font-weight:800;margin-left:4px}
      .dsp-moverow{display:flex;gap:6px;margin-top:4px}
      .dsp-moveto{flex:1;font:inherit;font-size:13px;padding:7px;border:1px solid #444;border-radius:7px;background:#1b1e24;color:inherit}
      .dsp-movego{font:inherit;font-size:13px;padding:7px 14px;border:1px solid #555;border-radius:7px;background:#23262d;color:inherit;cursor:pointer}
      .dsp-targetbar{border:1px solid #2f333a;border-radius:8px;padding:7px 10px;font-size:12.5px}
      .dsp-targetbar span{color:#c9cbd1}
      .dsp-rep{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 11px;border-radius:8px;font-size:13px;margin:6px 0}
      .dsp-rep span{color:#9aa;font-weight:400}
      .dsp-rep-ok{background:#12261a;border:1px solid #2c6b41;color:#8fe0ac}
      .dsp-rep-bad{background:#2a1414;border:1px solid #8a3b32;color:#f0a89f}
      .dsp-rep-none{background:#1b1e24;border:1px solid #2f333a;color:#889}
      .dsp-repmore{margin-left:auto;font:inherit;font-size:12px;padding:3px 10px;border:1px solid #7a4c46;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
      .dsp-replist{border:1px solid #2a2d33;border-radius:8px;overflow:hidden;margin-bottom:8px}
      .dsp-repitem{padding:8px 11px;border-bottom:1px solid #23262d;font-size:12.5px}
      .dsp-repitem:last-child{border-bottom:0}
      .dsp-repline{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
      .dsp-repfile{font-weight:700}
      .dsp-repfile i{color:#889;font-style:normal;font-weight:400}
      .dsp-replate{color:#f0a89f;font-weight:700}
      .dsp-repwhere{color:#889}
      .dsp-repcause{margin-left:auto;color:#ffd166;font-size:11.5px;border:1px solid #5c4a1f;border-radius:10px;padding:1px 8px}
      .dsp-repwhy{color:#b9bcc4;margin-top:4px;line-height:1.45}
      .dsp-repfix{color:#8fb7e0;margin-top:3px;line-height:1.45}
      .dsp-repnote{color:#ff9f43;margin-top:3px}
      .dsp-empty{color:#889;font-size:13px;padding:10px 2px}
      .dsp-h{font-size:12px;letter-spacing:.08em;color:#d6a832;font-weight:800;margin:14px 0 4px}
    </style>
    <div class="dsp-wrap" style="position:relative">
      <div id="dsp-drop"><div>⤵ drop to add to Dispatch</div></div>
      <div id="dsp-sheet"></div>
      <div class="dsp-hoursbar">
        <button id="dsp-hours-toggle" class="dsp-toggle">🕗 <span id="dsp-hours-sum">attended hours</span> <b id="dsp-caret">▸</b></button>
      </div>
      <div id="dsp-hours" style="display:none">
        <div class="dsp-row">
          Week <input type="week" id="dsp-week">
          <button id="dsp-save-all" title="These 7 days become the standing template">Save for every week</button>
          <button id="dsp-save-one" title="Only the selected calendar week uses these hours">This week only</button>
          <button id="dsp-clearov" style="display:none">Clear this week's override</button>
        </div>
        <div class="dsp-row" style="margin:2px 0">
          <label style="font-size:12.5px">Finish jobs
            <select id="dsp-policy" style="margin-left:4px">
              <option value="anytime">anytime - prints may run while I am out</option>
              <option value="attended">only while I am here</option>
            </select>
          </label>
        </div>
        <div style="color:#889;font-size:12px;margin:2px 0 6px">Jobs always START inside these hours - that is when you are around to swap spools and clear beds. Add a second block for days you're out in the middle. • = overridden day. Auto-start stays off — a human taps "Bed cleared".</div>
        <div class="dsp-days" id="dsp-days"></div>
      </div>
      <div class="dsp-row dsp-targetbar">
        <span title="One deadline for the whole queue. Jobs with a deadline of their own keep it.">🎯 Finish everything by</span>
        <input type="datetime-local" id="dsp-target">
        <button id="dsp-target-save">Set target</button>
        <button id="dsp-target-clear" style="display:none">Clear</button>
      </div>
      <div class="dsp-h">ADD JOB <span style="color:#889;font-weight:400">— several files become one bundle (multi-plate prints)</span></div>
      <div class="dsp-row">
        <select id="dsp-file"></select><button id="dsp-stage">+ add file</button>
        deadline <input type="datetime-local" id="dsp-dl">
        <label title="Plan this one to finish while you are around (delicate removal, same-day shipping)"><input type="checkbox" id="dsp-on"> be here at the finish</label>
        <input id="dsp-bundlename" placeholder="bundle name (e.g. Jones order)" style="display:none;min-width:200px">
        <button id="dsp-add">Add</button>
      </div>
      <div class="dsp-chipbox" id="dsp-chips"></div>
      <button id="dsp-jobs-toggle" class="dsp-toggle">JOBS <span id="dsp-jobs-sum"></span> <b id="dsp-jobs-caret">▾</b></button>
      <div id="dsp-jobs"></div>
      <div class="dsp-h">PLAN <button id="dsp-replan" style="font-size:11px;padding:2px 8px">↻ replan</button> <button id="dsp-adopt" style="font-size:11px;padding:2px 8px" title="Match prints already running on your printers to queued jobs, so Dispatch stops scheduling work the farm is already doing">⤓ claim running prints</button></div>
      <div id="dsp-report"></div>
      <div id="dsp-plan"></div>
    </div>`;

    $$("#dsp-hours-toggle").onclick = () => {
      const box = $$("#dsp-hours"), open = box.style.display === "none";
      box.style.display = open ? "" : "none";
      $$("#dsp-caret").textContent = open ? "▾" : "▸";
    };
    // Jobs list collapse — same pattern as hours, but open by default (it's the
    // working list); the choice sticks per browser like u1.camMode.
    if (typeof localStorage !== "undefined" && localStorage.getItem("u1.dspJobs") === "closed") {
      $$("#dsp-jobs").style.display = "none"; $$("#dsp-jobs-caret").textContent = "▸";
    }
    $$("#dsp-jobs-toggle").onclick = () => {
      const box = $$("#dsp-jobs"), open = box.style.display === "none";
      box.style.display = open ? "" : "none";
      $$("#dsp-jobs-caret").textContent = open ? "▾" : "▸";
      try { localStorage.setItem("u1.dspJobs", open ? "open" : "closed"); } catch {}
    };
    $$("#dsp-week").onchange = renderWeek;
    $$("#dsp-policy").onchange = async () => { await jpost("/api/dispatch/settings", { finish_policy: $$("#dsp-policy").value }); load(); };
    $$("#dsp-save-all").onclick = async () => { await jpost("/api/dispatch/settings", { week: readDays() }); load(); };
    $$("#dsp-save-one").onclick = async () => { await jpost("/api/dispatch/settings", { weekOverride: { key: selectedWeekKey(), days: readDays() } }); load(); };
    $$("#dsp-clearov").onclick = async () => { await jpost("/api/dispatch/settings", { clearOverride: selectedWeekKey() }); load(); };
    // Farm target. Errors surface — a target that silently didn't save is
    // worse than none, because the green banner would be lying.
    $$("#dsp-target-save").onclick = async () => {
      const v = $$("#dsp-target").value;
      if (!v) return alert("Pick a date and time first, or press Clear to remove the target.");
      const r = await jpost("/api/dispatch/settings", { target: new Date(v).getTime() });
      if (!r.ok) alert((r.body && r.body.error) || "Could not set that target");
      REPOPEN = true;                      // they just asked the question — show the answer
      load();
    };
    $$("#dsp-target-clear").onclick = async () => {
      await jpost("/api/dispatch/settings", { target: null });
      $$("#dsp-target").value = ""; load();
    };
    $$("#dsp-stage").onclick = () => addChip($$("#dsp-file").value);
    $$("#dsp-add").onclick = async () => {
      if (!FILEQ.length && $$("#dsp-file").value) addChip($$("#dsp-file").value);
      if (!FILEQ.length) return;
      const dl = $$("#dsp-dl").value ? new Date($$("#dsp-dl").value).getTime() : null;
      const nf = $$("#dsp-on").checked;
      let r;
      if (FILEQ.length === 1) {
        r = await jpost("/api/dispatch/jobs", { file: FILEQ[0].file, type: FILEQ[0].type, qty: FILEQ[0].qty || 1, deadline: dl, needs_finish: nf });
      } else {
        // One bundle. bundle-jobs applies a single qty to every member, so when
        // the counts differ (2 clickers + 1 stego) the bundle is created with
        // the common qty and the extras are added as individual jobs joined to
        // it — the user's per-file numbers are honored exactly either way.
        const qtys = FILEQ.map(x => x.qty || 1);
        const base = Math.min(...qtys);
        r = await jpost("/api/dispatch/bundle-jobs", {
          files: FILEQ.map(x => x.file), type: FILEQ[0].type, qty: base,
          deadline: dl, needs_finish: nf, name: $$("#dsp-bundlename").value.trim()
        });
        if (r.ok && r.body && r.body.jobs) {
          for (const j of r.body.jobs) {
            const want = (FILEQ.find(x => x.file === j.file) || {}).qty || base;
            if (want !== base) await jpost("/api/dispatch/jobs/update", { id: j.id, qty: want });
          }
        }
      }
      if (!r.ok) alert((r.body && r.body.error) || "Add failed");
      else { FILEQ = []; $$("#dsp-bundlename").value = ""; $$("#dsp-dl").value = ""; $$("#dsp-on").checked = false; }
      load();
    };
    $$("#dsp-replan").onclick = load;
    $$("#dsp-adopt").onclick = async () => {
      const b = $$("#dsp-adopt"), was = b.textContent;
      b.disabled = true; b.textContent = "\u2026";
      const r = await jpost("/api/dispatch/adopt", {});
      b.disabled = false; b.textContent = was;
      const ad = (r.body && r.body.adopted) || [];
      const al = (r.body && r.body.already) || [];
      const un = (r.body && r.body.unmatched) || [];
      const lines = [];
      if (ad.length) lines.push("Claimed " + ad.length + " running print" + (ad.length > 1 ? "s" : "") + ":\n" +
        ad.map(x => "  \u2022 " + x.printer + ": " + x.file + (x.paused ? "  (paused)" : "")).join("\n"));
      if (al.length) lines.push(al.length + " already tracked:\n" +
        al.map(x => "  \u2022 " + x.printer + ": " + x.file + (x.paused ? "  (paused)" : "")).join("\n"));
      if (un.length) lines.push("Running but not in Dispatch (add them if you want them tracked):\n" +
        un.map(x => "  \u2022 " + x.printer + ": " + x.file + (x.paused ? "  (paused)" : "")).join("\n"));
      if (!lines.length) lines.push("Nothing is printing right now.");
      alert(lines.join("\n\n"));
      load();
    };

    // ---- drag-and-drop from the core file list ----
    // The whole view is the drop target (the old thin strip was a poor
    // target, especially on a laptop trackpad); an overlay makes it obvious.
    const hasFile = e => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes("application/x-u1hub-file");
    let dragDepth = 0;
    const showOverlay = on => { $$("#dsp-drop").style.display = on ? "flex" : "none"; };
    el.addEventListener("dragenter", e => { if (!hasFile(e)) return; e.preventDefault(); dragDepth++; showOverlay(true); });
    el.addEventListener("dragover", e => { if (!hasFile(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    el.addEventListener("dragleave", e => { if (!hasFile(e)) return; if (--dragDepth <= 0) { dragDepth = 0; showOverlay(false); } });
    el.addEventListener("drop", e => {
      if (!hasFile(e)) return;
      e.preventDefault(); dragDepth = 0; showOverlay(false);
      try { const { file, type } = JSON.parse(e.dataTransfer.getData("application/x-u1hub-file")); addChip(file, type); } catch {}
    });
    // hovering the Dispatch tab mid-drag switches to this view
    document.querySelectorAll('.vtab[data-view="dispatch"]').forEach(t =>
      t.addEventListener("dragenter", () => setView("dispatch")));
  }

  async function onShow() {
    try {
      const t = (typeof activeType === "function" && activeType().slug) || "u1";
      const files = await (await fetch("/api/files?type=" + encodeURIComponent(t))).json();
      const list = (files.files || files || []).map(f => f.name || f).filter(n => /\.gcode$/i.test(n));
      $$("#dsp-file").innerHTML = list.map(n => `<option>${esc(n)}</option>`).join("") || "<option value=''>— no gcode files —</option>";
    } catch {}
    load();
  }

  function onFleet() {
    if (EL && EL.style.display !== "none" && STATE) jget("/api/dispatch").then(d => {
      if (d.body) { const was = JSON.stringify(STATE.awaiting), now2 = JSON.stringify(d.body.awaiting);
        STATE = d.body; if (was !== now2) renderPlan(); }
    });
  }

  // Claimed file action: core renders "📋 Send to Dispatch" next to "Add to
  // queue" and calls this. It's the ONLY path on phones and tablets — touch
  // never fires HTML5 drag events, so drag-and-drop is a desktop nicety and
  // this button is the real interface.
  async function fileAction(file, type) {
    addChip(file, type);
    setView("dispatch");
    if (EL) await onShow();
  }

  window.HubModules.register("dispatch", {
    tab: "Dispatch", mount, onShow, onFleet,
    fileAction, fileLabel: "\u{1F4CB} Send to Dispatch"
  });
})();
