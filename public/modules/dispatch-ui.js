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
  let CHANGES = null;                              // last replan's diff, or null
  const PPH_STEPS = [24, 48, 90, 180];             // guide zoom: pixels per hour
  let PPH = 48;
  try { const z = +localStorage.getItem("u1.dspZoom"); if (PPH_STEPS.includes(z)) PPH = z; } catch {}
  const LANE_W = 132;                              // sticky "channel" column width
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
  // Weekday + time alone was a trap (fixed v2.15): "Tue 05:00 PM" reads as
  // tomorrow whether it is tomorrow or a fortnight away, and a deadline is
  // exactly where that difference decides what you do. Every absolute moment
  // now carries its date. fmtClock stays bare for the guide's ruler, where the
  // day is already written above the column.
  const fmtT = ms => new Date(ms).toLocaleString([],
    { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtDay = ms => new Date(ms).toLocaleDateString([],
    { weekday: "short", day: "numeric", month: "short" });
  const fmtClock = ms => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = (a, b) => { const x = new Date(a), y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
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

  // Take a printer out of service, or put it back. The server answers with the
  // replanned board, so the redistribution this click caused is on screen in
  // one round trip rather than after the next poll — you press it and you can
  // see immediately where the work went.
  //
  // No confirm() and no prompt() anywhere in here: a browser modal blocks the
  // page, and this is a control someone taps on a phone standing next to a
  // printer with the panel already off. The action is one click to undo.
  async function toggleMaint(idx, btn) {
    const cur = ((PLAN.printers || []).find(p => p.idx === idx) || {}).maintenance || null;
    btn.disabled = true;
    const r = await jpost("/api/dispatch/maintenance", { printer: idx, down: !cur });
    btn.disabled = false;
    if (r.ok && r.body && r.body.plan && !r.body.plan.error) { PLAN = r.body.plan; render(); }
    else await load();          // something disagreed — re-read rather than guess
  }

  async function load() {
    const [d, p] = await Promise.all([jget("/api/dispatch"), jget("/api/dispatch/plan")]);
    STATE = d.body || { jobs: [], bundles: [], settings: {} };
    PLAN = p.body || { slots: [] };
    render();
  }

  function render() { if (!STATE) return; renderWeek(); renderTarget(); renderChips(); renderJobs(); renderReport(); renderChanges(); renderPlan(); }

  // ---- farm completion target + feasibility report (v2.13) -----------------
  // "Everything done by Friday 5pm." One datetime for the whole queue, because
  // that is the shape a show or a customer pickup actually has. The server
  // treats it as a FALLBACK deadline (a job's own deadline still wins) and
  // hands back a report; this half only has to say it plainly.
  function renderTarget() {
    const t = (STATE.settings || {}).target || null;
    dtSet($$("#dsp-target"), t);
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
      // v2.22 PRIORITY (Danny): 1-5, 5 runs first. It only breaks ties between
      // jobs that share a deadline — a due date always wins — so this is the
      // "bump this ahead of the other un-urgent stuff" dial, not an override.
      const prio = (j.priority >= 1 && j.priority <= 5) ? j.priority : 3;
      const prioSel = `<select class="dsp-jprio dsp-prio${prio}" data-dsp-prio="${esc(j.id)}" ` +
        `title="Priority — 5 runs first. Breaks ties between jobs sharing a deadline; it never jumps one ahead of an earlier deadline.">` +
        [5, 4, 3, 2, 1].map(n => `<option value="${n}"${n === prio ? " selected" : ""}>P${n}${n === 5 ? " top" : n === 3 ? " normal" : n === 1 ? " low" : ""}</option>`).join("") +
        `</select>`;
      // v2.23.2: a job whose file has left the library cannot be started from
      // the dashboard, so say so on the row instead of at the last tap.
      const gone = j.file_missing
        ? ` <span class="dsp-jmissing" title="This file is no longer in the Hub library (deleted after the job was queued?). Re-slice it or copy it back from a printer's storage, or remove the job.">file missing</span>`
        : "";
      return `<div class="dsp-job dsp-${esc(j.state)}${j.bundle_id ? " dsp-inbundle" : ""}${j.file_missing ? " dsp-filemissing" : ""}">
        <span class="dsp-jfile">${esc(j.file)}${gone}</span><span>${j.remaining}/${j.qty}</span>
        <span title="deadline">${esc(dl)}</span>
        ${prioSel}
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
    // v2.22: change a job's priority. Re-reads so the reordered plan shows at
    // once — a bump only moves jobs that share a deadline, so most changes are
    // visible as a re-sort of the un-urgent tail.
    box.querySelectorAll("[data-dsp-prio]").forEach(sel => sel.onchange = async () => {
      await jpost("/api/dispatch/jobs/update", { id: sel.dataset.dspPrio, priority: +sel.value }); load();
    });
  }

  // ---- the guide ------------------------------------------------------------
  // v2.15: the plan is a TV listings grid. Printers are the channels down the
  // left, a real clock runs across the top, and a block's WIDTH is its runtime.
  //
  // The old view stretched every plan to the same width and positioned blocks
  // by percentage, so a 20-minute print and a 10-hour print drew the same box
  // and "when does this start?" had no answer on screen — you had to tap each
  // block to find out. Everything here is anchored to one scale: PPH pixels per
  // hour from t0, so distance IS time. Scroll is horizontal; the channel column
  // and the ruler stay put, because losing track of which machine or which day
  // you are reading is the one thing a guide must never let happen.
  let GSCROLL = null;                              // survive re-render, don't jump the view
  function renderPlan() {
    const box = $$("#dsp-plan");
    const slots = (PLAN && PLAN.slots) || [];
    const bad = slots.filter(s => s.unplannable);
    const good = slots.filter(s => !s.unplannable);
    const printers = (PLAN && PLAN.printers) || [];
    if (!good.length && !bad.length && !printers.length) {
      box.innerHTML = '<div class="dsp-empty">Nothing planned.</div>'; return;
    }
    const prev = $$("#dsp-guide");
    if (prev) GSCROLL = prev.scrollLeft;
    const HOUR = 3600000, now = Date.now();
    // Round out to whole hours so the ruler's labels are round numbers. v2.22:
    // the axis begins where the WORK begins, not always at the present. A print
    // running now legitimately pins the guide to now — it starts now. But when
    // nothing is on the beds and the next job can't start until a later window,
    // anchoring to now just draws hours of dead grey before the first bar (the
    // "empty space at the front" Danny called out). With nothing running the
    // schedule slides forward and opens on the first job's real start time.
    const RUN0 = (PLAN && PLAN.running) || [];
    const firstStart = good.length ? Math.min(...good.map(s => s.est_start)) : now;
    const earliest = RUN0.length ? Math.min(now, firstStart) : firstStart;
    const latest = good.length ? Math.max(now + 2 * HOUR, ...good.map(s => s.est_end)) : now + 8 * HOUR;
    const t0 = Math.floor(earliest / HOUR) * HOUR;
    const t1 = Math.ceil((latest + HOUR / 2) / HOUR) * HOUR;
    const hours = Math.max(4, Math.round((t1 - t0) / HOUR));
    const W = hours * PPH;
    const x = ms => ((ms - t0) / HOUR) * PPH;

    // Every online printer gets a channel, including the idle ones. A machine
    // vanishing from the guide hides exactly the capacity problem worth seeing.
    const byPrinter = {};
    for (const p of printers) byPrinter[p.idx] = { name: p.name, slots: [] };
    for (const s of good)
      (byPrinter[s.printer] = byPrinter[s.printer] || { name: s.printerName, slots: [] }).slots.push(s);

    // Ruler: a day band above, hour ticks below. Label density follows the
    // zoom — cramming 5pm next to 6pm at 24px/h just makes a grey smear.
    let days = "", ticks = "";
    for (let h = 0; h < hours; h++) {
      const t = t0 + h * HOUR, d = new Date(t);
      if (d.getHours() === 0 || h === 0) {
        const nextMid = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        const to = Math.min(nextMid, t1);
        const bw = Math.max(0, x(to) - x(t));
        // The first band is usually a stub — the plan starts mid-evening, so
        // that day has an hour or two left. A clipped "Sun, A" butting into the
        // next day's label is worse than no label; the divider still reads.
        days += `<div class="dsp-gday" style="left:${x(t)}px;width:${bw}px">` +
                (bw >= 64 ? `<span>${esc(fmtDay(t))}</span>` : "") + `</div>`;
      }
      const every = PPH >= 180 ? 1 : PPH >= 90 ? 2 : PPH >= 48 ? 3 : 6;
      const label = d.getHours() % every === 0 ? fmtClock(t) : "";
      ticks += `<div class="dsp-gtick${d.getHours() === 0 ? " dsp-gmid" : ""}" style="left:${x(t)}px">` +
               (label ? `<span>${esc(label)}</span>` : "") + `</div>`;
    }
    // Hours you are not around, shaded behind everything. These intervals come
    // from the SERVER (plan.attended) — re-deriving the week template, its
    // overrides and away blocks here would be a second implementation of the
    // scheduler, and the day it drifted the guide would show a job starting
    // inside grey. No windows reported (older Hub, or nothing to say) → no
    // shading, rather than a guide that is wrong-looking on purpose.
    const att = (PLAN && PLAN.attended) || [];
    let closed = "";
    if (att.length) {
      let cur = t0;
      for (const a of att) {
        const f = Math.max(t0, a.from), to = Math.min(t1, a.to);
        if (to <= cur) continue;
        if (f > cur) closed += `<i style="left:${x(cur)}px;width:${x(f) - x(cur)}px"></i>`;
        cur = Math.max(cur, to);
      }
      if (cur < t1) closed += `<i style="left:${x(cur)}px;width:${x(t1) - x(cur)}px"></i>`;
    }
    const nowLine = now >= t0 && now <= t1
      ? `<div class="dsp-gnow" style="left:${x(now)}px"></div>` : "";

    // What is on the beds right now, from plan.running — a separate list, and
    // kept separate here too. It is the most certain thing on the guide and it
    // is not planned work: no deadline color, no move, no tap-to-replan.
    const RUN = (PLAN && PLAN.running) || [];
    const runBlocks = idx => RUN.filter(r => r.printer === idx).map((r, i) => {
      const l = Math.max(0, x(now)), w = Math.max(7, x(r.est_end) - l);
      const name = (r.file || "unknown file").replace(/\.gcode$/i, "");
      const until = r.eta_unknown ? "ETA unknown" : "until " + fmtClock(r.est_end);
      const body = w >= 120 ? `<b>${esc(name)}</b><span>${esc(until)}</span>`
                 : w >= 62 ? `<b>${esc(name)}</b>` : "";
      return `<div class="dsp-grun${r.eta_unknown ? " dsp-grunq" : ""}${r.paused ? " dsp-grunp" : ""}" ` +
        `data-run="${i}" data-runp="${idx}" style="left:${l}px;width:${w}px" ` +
        `title="${r.paused ? "PAUSED" : "PRINTING NOW"} on ${esc(r.printerName)}\n${esc(name)}\n` +
        `${r.eta_unknown ? "remaining time unknown — the lane is planned pessimistically" : "ends about " + esc(fmtT(r.est_end))}` +
        `${r.tracked ? "" : "\nnot tracked by Dispatch — use ⤓ claim running prints"}">` +
        `<span class="dsp-gtext">${body}</span>` +
        `<b class="dsp-grunicon">${r.paused ? "⏸" : "▶"}</b></div>`;
    }).join("");

    const awaiting = new Set(STATE.awaiting || []);
    const laneRows = Object.entries(byPrinter).map(([idx, lane]) => {
      const blocks = lane.slots.map(s => {
        const l = x(s.est_start), w = Math.max(7, x(s.est_end) - l);
        const name = s.file.replace(/\.gcode$/i, "");
        const swapBadge = s.swaps.length
          ? `<b class="dsp-swapn" title="${esc(s.swaps.map(v => (v.spool ? v.spool + " (" + v.color + ")" : v.color)).join("\n"))}">${s.swaps.length}⇄</b>` : "";
        const clash = s.contention
          ? `<b class="dsp-clash" title="${esc(s.contention.color)} also needed by ${esc(s.contention.file)} on ${esc(s.contention.printer)}">⚠</b>` : "";
        const idle = s.idle_after_min
          ? `<b class="dsp-idle" title="then waits ${esc(fmtMin(s.idle_after_min))} for you to clear the bed">\u{1F4A4}</b>` : "";
        // What fits, fits. Below ~62px a name is two letters and an ellipsis,
        // which tells you nothing a bare bar doesn't — so a short print is a
        // bar you tap, and the tooltip and the sheet carry the detail.
        const body = w >= 120
          ? `<b>${esc(name)}</b><span>${esc(fmtClock(s.est_start))}–${esc(fmtClock(s.est_end))}</span>`
          : w >= 62 ? `<b>${esc(name)}</b>` : "";
        return `<div class="dsp-gblk${s.misses_deadline ? " dsp-gmiss" : ""}" data-slot="${good.indexOf(s)}" ` +
          `style="left:${l}px;width:${w}px" title="${esc(name)} #${s.copy}/${s.of}\n${esc(fmtT(s.est_start))} → ${esc(fmtT(s.est_end))} (${esc(fmtMin(s.est_minutes))})` +
          `${s.est_assumed ? "\n(no estimate in file — 1 h assumed)" : ""}${s.misses_deadline ? "\n⚠ MISSES ITS DEADLINE" : ""}">` +
          `<span class="dsp-gtext">${body}</span>${swapBadge}${clash}${idle}</div>`;
      }).join("");
      // v2.19 maintenance. Deliberately its own word and its own color: an
      // offline machine is a fact the Hub discovered, a machine down for
      // maintenance is a decision you made, and a farm where those two look the
      // same is a farm where you go hunting for a fault you caused.
      const maint = ((PLAN.printers || []).find(p => p.idx === +idx) || {}).maintenance || null;
      const busyNow = RUN.find(r => r.printer === +idx);
      const wrench = `<button class="dsp-maint${maint ? " dsp-maint-on" : ""}" data-dsp-maint="${idx}"` +
        ` title="${maint ? "Bring this printer back into service" : "Take this printer down for maintenance"}"` +
        ` aria-pressed="${maint ? "true" : "false"}">${maint ? "↩ back in service" : "⚒ take down"}</button>`;
      // Nothing new can be started on a machine that is down, so the button
      // that starts things does not appear on it.
      const clearBtn = maint ? "" : (awaiting.has(+idx)
        ? `<button class="dsp-clear" data-dsp-clear="${idx}">Bed cleared → next</button>`
        : `<button class="dsp-clear dsp-idleclear" data-dsp-clear="${idx}" title="Hand this printer its next planned job now">▶ next</button>`);
      const first = maint
        // A print already on the bed keeps running — taking a machine down
        // stops it being GIVEN work, it does not reach in and cancel yours.
        ? `<span class="dsp-gsub dsp-gmaint">${busyNow
            ? "⚒ finishing, then down"
            : "⚒ down for maintenance"}${maint.note ? " — " + esc(maint.note) : ""}</span>`
        : busyNow
        ? `<span class="dsp-gsub dsp-grunning">${busyNow.paused ? "⏸ paused" : "▶ printing now"}</span>`
        : lane.slots.length
          ? `<span class="dsp-gsub">from ${esc(fmtClock(Math.min(...lane.slots.map(s => s.est_start))))}</span>`
          : `<span class="dsp-gsub dsp-lidle">idle — nothing planned</span>`;
      return `<div class="dsp-grow${maint ? " dsp-rowmaint" : (busyNow ? " dsp-rowrun" : "")}">
        <div class="dsp-gcell"><span class="dsp-gpname">${esc(lane.name)}</span>${first}${clearBtn}${wrench}</div>
        <div class="dsp-gtime" style="width:${W}px">${closed}${nowLine}${runBlocks(+idx)}${blocks}</div>
      </div>`;
    }).join("");

    const zoom = PPH_STEPS.map(p =>
      `<button class="dsp-gz${p === PPH ? " dsp-gzon" : ""}" data-pph="${p}">${p >= 180 ? "15m" : p >= 90 ? "30m" : p >= 48 ? "1h" : "3h"}</button>`).join("");
    // v2.22 FLUID / LOCKED (Danny). Fluid keeps re-optimizing as the farm
    // changes; locked freezes the plan you approved so the times stop shifting.
    // The button both SHOWS the mode and toggles it, and when locked it reports
    // anything queued after the freeze that the frozen board isn't showing.
    const locked = !!(PLAN && PLAN.locked);
    const newLock = (PLAN && PLAN.new_since_lock) || [];
    const newCount = newLock.reduce((n, x2) => n + (x2.count || 0), 0);
    const lockBtn = `<button class="dsp-glock${locked ? " dsp-glock-on" : ""}" id="dsp-glockbtn" ` +
      `title="${locked
        ? "LOCKED — the plan is frozen at the times you approved; new work waits off to the side. Click to go back to a live, self-adjusting schedule."
        : "FLUID — the plan re-optimizes as prints finish and jobs change. Click to freeze exactly what you see now so the times stop moving."}">` +
      `${locked ? "🔒 locked" : "🌊 fluid"}</button>`;
    const lockNote = locked && newCount
      ? `<span class="dsp-gnewlock" title="${esc(newLock.map(x2 => x2.count + "× " + x2.file).join("\n"))}">` +
        `+${newCount} new since lock — unlock to schedule ${newCount === 1 ? "it" : "them"}</span>`
      : "";
    box.innerHTML = `
      <div class="dsp-gtools">
        <span class="dsp-gsub">detail</span>${zoom}
        <button class="dsp-gjump" id="dsp-gnowbtn">⊙ now</button>
        ${lockBtn}${lockNote}
        <span class="dsp-gkey"><i class="dsp-krun"></i>printing now <i class="dsp-kblk"></i>planned <i class="dsp-kmiss"></i>misses deadline <i class="dsp-kclosed"></i>you're away</span>
      </div>
      <div class="dsp-guide" id="dsp-guide">
        <div class="dsp-gtrack" style="width:${LANE_W + W}px">
          <div class="dsp-grow dsp-gruler">
            <div class="dsp-gcell dsp-gcorner"><span class="dsp-gsub">printer</span></div>
            <div class="dsp-gtime" style="width:${W}px">${days}${ticks}${nowLine}</div>
          </div>
          ${laneRows}
        </div>
      </div>` +
      (bad.length ? `<div class="dsp-empty">⚠ ${bad.length} cop${bad.length === 1 ? "y" : "ies"} unplannable: ${esc(bad[0].unplannable)}</div>` : "");

    box.querySelectorAll("[data-dsp-clear]").forEach(b => b.onclick = () => clearBed(+b.dataset.dspClear, b));
    box.querySelectorAll("[data-dsp-maint]").forEach(b => b.onclick = () => toggleMaint(+b.dataset.dspMaint, b));
    // Touch has no hover, so the title attribute is invisible on a phone.
    // Tapping opens everything the block could not say.
    //
    // v2.19: these are divs with click handlers, which means they were not in
    // the tab order at all — the entire timeline was unreachable by keyboard,
    // and a focus ring in gold.css could never have fired on them because
    // nothing could focus them in the first place. tabindex puts them in the
    // order, role tells a screen reader what they are, and Enter/Space do what
    // a click does. No CSS could have fixed this; it needed the markup.
    const activatable = (b, fn) => {
      b.onclick = fn;
      b.tabIndex = 0;
      b.setAttribute("role", "button");
      b.onkeydown = e => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); fn(); }
      };
    };
    box.querySelectorAll("[data-slot]").forEach(b => activatable(b, () => showSlot(good[+b.dataset.slot])));
    box.querySelectorAll("[data-run]").forEach(b => activatable(b, () =>
      showRunning(RUN.filter(r => r.printer === +b.dataset.runp)[+b.dataset.run])));
    box.querySelectorAll("[data-pph]").forEach(b => b.onclick = () => {
      PPH = +b.dataset.pph;
      try { localStorage.setItem("u1.dspZoom", String(PPH)); } catch {}
      GSCROLL = null;                              // scale changed; the old offset means nothing
      renderPlan();
    });
    const g = $$("#dsp-guide");
    const toNow = () => { if (g) g.scrollLeft = Math.max(0, x(now) - 48); };
    const jump = $$("#dsp-gnowbtn");
    if (jump) jump.onclick = toNow;
    // v2.22: freeze / unfreeze. The server snapshots (or clears) the plan and
    // we re-read the board so the frozen times — or the live ones — are on
    // screen in one tap. No confirm(): locking is one click to undo.
    const lockToggle = $$("#dsp-glockbtn");
    if (lockToggle) lockToggle.onclick = async () => {
      lockToggle.disabled = true;
      await jpost("/api/dispatch/lock", { lock: !locked });
      await load();
    };
    // Restore where they were reading; land on "now" only the first time.
    if (g) { if (GSCROLL != null) g.scrollLeft = GSCROLL; else toNow(); }
  }

  // A running print has no plan to explain — only facts, and one honest gap:
  // the Hub is told the remaining time, never the start, so "began at" is a
  // number it does not have and will not invent.
  function showRunning(r) {
    if (!r) return;
    const rows = [
      ["Printer", r.printerName],
      ["State", r.paused ? "⏸ paused — still holding the bed and its filament" : "▶ printing"],
      ["File", r.file || "the printer didn't name a file"],
      ["Ends", r.eta_unknown ? "unknown — this lane is planned pessimistically (+8 h)" : fmtT(r.est_end)],
      ["Started", "not reported — the Hub is told what remains, not when it began"],
      ["Dispatch", r.tracked ? "tracked: this is a job in your queue"
                             : "NOT tracked — tap ⤓ claim running prints to match it to a job"]
    ];
    $$("#dsp-sheet").innerHTML = `
      <div class="dsp-sheetbox">
        <div class="dsp-sheettitle">${esc((r.file || "Running print").replace(/\.gcode$/i, ""))}</div>
        <table class="dsp-sheettab">${rows.map(x2 => `<tr><td>${esc(x2[0])}</td><td>${esc(x2[1])}</td></tr>`).join("")}</table>
        <div class="dsp-sheetsub">This is what the machine is doing, not a plan</div>
        <div style="color:var(--ink-faint, #889);font-size:12px">Dispatch never schedules over a running print, and never moves one.</div>
        <button class="dsp-sheetclose">Close</button>
      </div>`;
    $$("#dsp-sheet").style.display = "flex";
    $$("#dsp-sheet").onclick = e => {
      if (e.target.id === "dsp-sheet" || e.target.classList.contains("dsp-sheetclose"))
        $$("#dsp-sheet").style.display = "none";
    };
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
      s.after ? ["Pushed back", "waiting for " + (s.after_file || "another job") + " to finish"] : null,
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
        <div class="dsp-sheetsub">Run it later${s.contention ? ` <span class="dsp-anyslot">— the ${esc(s.contention.color)} it needs is busy</span>` : ""}</div>
        <div class="dsp-moverow">
          <button class="dsp-pushback" data-job="${esc(s.job_id)}">Push back one</button>
          ${s.after ? `<button class="dsp-pushclear" data-job="${esc(s.job_id)}">Undo — run at its normal turn</button>` : ""}
        </div>
        <div class="dsp-hinttext" style="margin-top:4px">Sends it behind the next job in the plan, so the one after it
          runs instead. Press again to move it back another place.</div>
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
    // v2.20 push back. The sheet stays open on success and re-renders against
    // the new plan, so pressing it three times to clear a spool clash is three
    // presses and not three round trips through the timeline. A refusal — the
    // job is already last — is shown in place rather than silently doing
    // nothing, because a button that sometimes does nothing is worse than one
    // that says why.
    const pb = $$(".dsp-pushback");
    if (pb) pb.onclick = async () => {
      pb.disabled = true; pb.textContent = "pushing…";
      const r = await jpost("/api/dispatch/jobs/push-back", { id: pb.dataset.job });
      if (!r.ok) {
        pb.disabled = false; pb.textContent = "Push back one";
        const msg = document.createElement("div");
        msg.className = "dsp-hinttext";
        msg.style.color = "var(--bad,#F26B5E)";
        msg.textContent = (r.body && r.body.error) || "Could not push that back.";
        pb.parentElement.after(msg);
        return;
      }
      if (r.body.plan && !r.body.plan.error) PLAN = r.body.plan;
      await load();
      // Re-open on the same job so the next press is immediate.
      const again = ((PLAN && PLAN.slots) || []).find(x => x.job_id === pb.dataset.job && !x.unplannable);
      if (again) showSlot(again); else $$("#dsp-sheet").style.display = "none";
    };
    const pc = $$(".dsp-pushclear");
    if (pc) pc.onclick = async () => {
      pc.disabled = true;
      const r = await jpost("/api/dispatch/jobs/push-back", { id: pc.dataset.job, clear: true });
      if (r.ok && r.body.plan) PLAN = r.body.plan;
      await load();
      const again = ((PLAN && PLAN.slots) || []).find(x => x.job_id === pc.dataset.job && !x.unplannable);
      if (again) showSlot(again); else $$("#dsp-sheet").style.display = "none";
    };
  }

  async function clearBed(idx, btn) {
    btn.disabled = true;
    try {
      const r = await jpost("/api/dispatch/clear-bed", { printer: idx });
      const next = r.body && r.body.next;
      if (!next) { btn.textContent = "nothing planned"; setTimeout(load, 1200); return; }
      // v2.23.2: the file must be in the Hub library for the dashboard to send
      // it. Before this the handoff below selected a file that was not there,
      // the dashboard opened with nothing loaded, and nothing said why.
      if (next.in_library === false) {
        alert("'" + next.file + "' is planned next for " + next.printerName + ", but it is no longer in the Hub's library, so the dashboard can't send it.\n\n" +
              "Put the file back in the library (re-slice it, or copy it from a printer's storage), or remove the job from Dispatch.");
        btn.disabled = false; return;
      }
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
      // mapping UI (and 2.10's duplicate-color rules). Select the file, jump
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

  // ---- replan: progress, then what actually changed --------------------------
  // Replan used to silently swap the picture. But the interesting part of a
  // replan IS the diff — what moved, what slipped, what now misses — and a
  // redraw is precisely what destroys it. So: snapshot, refetch, compare, say.
  //
  // The bar tracks real work (queue fetched, plan fetched, diff computed), not
  // a timer pretending to be work. On a small farm it is over in a blink, so it
  // holds briefly at the end rather than flashing — the point is to show that
  // something ran, and to give a failure somewhere to appear instead of the
  // screen simply not changing.
  const planKey = s => s.job_id + "#" + s.copy;
  function snapshotPlan(plan) {
    const m = new Map();
    for (const s of ((plan && plan.slots) || []).filter(x => !x.unplannable))
      m.set(planKey(s), { printer: s.printer, printerName: s.printerName, file: s.file,
                          start: s.est_start, copy: s.copy, of: s.of, miss: !!s.misses_deadline });
    return m;
  }
  const SHIFT_MIN = 5;            // under this, a start-time move is estimate noise, not news
  function diffPlans(before, after) {
    const out = [];
    for (const [k, b] of before) {
      const a = after.get(k);
      if (!a) { out.push({ kind: "gone", file: b.file, copy: b.copy, of: b.of,
                           text: "is no longer in the plan" }); continue; }
      if (a.printer !== b.printer)
        out.push({ kind: "moved", file: a.file, copy: a.copy, of: a.of,
                   text: "moved " + b.printerName + " → " + a.printerName });
      const shift = Math.round((a.start - b.start) / 60000);
      if (Math.abs(shift) >= SHIFT_MIN)
        out.push({ kind: shift < 0 ? "earlier" : "later", file: a.file, copy: a.copy, of: a.of,
                   text: "starts " + fmtMin(Math.abs(shift)) + (shift < 0 ? " earlier" : " later") +
                         " — now " + fmtT(a.start) });
      if (a.miss !== b.miss)
        out.push({ kind: a.miss ? "nowmiss" : "nowmakes", file: a.file, copy: a.copy, of: a.of,
                   text: a.miss ? "now MISSES its deadline" : "now makes its deadline" });
    }
    for (const [k, a] of after)
      if (!before.has(k)) out.push({ kind: "new", file: a.file, copy: a.copy, of: a.of,
                                     text: "added on " + a.printerName + " at " + fmtT(a.start) });
    // Bad news first: a copy that started missing its deadline is the reason to
    // read this list at all.
    const rank = { nowmiss: 0, gone: 1, later: 2, moved: 3, new: 4, earlier: 5, nowmakes: 6 };
    out.sort((p, q) => (rank[p.kind] ?? 9) - (rank[q.kind] ?? 9));
    return out;
  }
  async function replan() {
    const bar = $$("#dsp-progress");
    const fill = bar && bar.querySelector(".dsp-pbfill");
    const lbl = bar && bar.querySelector(".dsp-pblabel");
    const step = (pct, text, bad) => {
      if (!bar) return;
      bar.style.display = "";
      bar.classList.toggle("dsp-pbbad", !!bad);
      if (fill) fill.style.width = pct + "%";
      if (lbl) lbl.textContent = text;
    };
    const t0 = Date.now();
    step(10, "reading the queue…");
    const d = await jget("/api/dispatch");
    step(50, "planning…");
    const p = await jget("/api/dispatch/plan");
    if (!p.ok || !p.body || !p.body.slots) {
      // Never overwrite a good plan with a failed fetch: what is on screen is
      // still true, and saying so beats blanking it.
      step(100, (p.body && p.body.error) || "planning failed — the plan on screen is the one from before", true);
      setTimeout(() => { if (bar) bar.style.display = "none"; }, 4000);
      return;
    }
    step(80, "comparing…");
    const before = snapshotPlan(PLAN);
    STATE = d.body || STATE;
    PLAN = p.body;
    CHANGES = { at: Date.now(), items: diffPlans(before, snapshotPlan(PLAN)) };
    const n = CHANGES.items.length;
    step(100, n ? n + " change" + (n === 1 ? "" : "s") : "no changes");
    const hold = Math.max(0, 400 - (Date.now() - t0));
    setTimeout(() => { if (bar) bar.style.display = "none"; }, hold + 550);
    render();
  }
  function renderChanges() {
    const box = $$("#dsp-changes");
    if (!box) return;
    if (!CHANGES) { box.innerHTML = ""; return; }
    const items = CHANGES.items;
    const head = items.length
      ? `<b>${items.length} change${items.length === 1 ? "" : "s"} from that replan</b>`
      : `<b>Replanned — nothing moved.</b> <span>Same printers, same times.</span>`;
    box.innerHTML =
      `<div class="dsp-chg${items.length ? "" : " dsp-chgnone"}">${head}` +
      `<button class="dsp-chgx" id="dsp-chgx" title="dismiss">✕</button></div>` +
      (items.length ? `<div class="dsp-chglist">` + items.slice(0, 40).map(it =>
        `<div class="dsp-chgrow dsp-k-${esc(it.kind)}">
           <span class="dsp-chgfile">${esc(it.file.replace(/\.gcode$/i, ""))}${it.of > 1 ? ` <i>#${it.copy}/${it.of}</i>` : ""}</span>
           <span class="dsp-chgtext">${esc(it.text)}</span>
         </div>`).join("") +
        (items.length > 40 ? `<div class="dsp-chgrow"><span class="dsp-chgtext">…and ${items.length - 40} more</span></div>` : "") +
        `</div>` : "");
    const xb = $$("#dsp-chgx");
    if (xb) xb.onclick = () => { CHANGES = null; renderChanges(); };
  }

  // ---- date + time flyout ----------------------------------------------------
  // A native datetime-local is a different control in every browser, and on a
  // phone the calendar hides behind an icon the width of a grain of rice. A
  // deadline earns a real month grid and a real clock, in one popover, with the
  // whole moment — date AND time — settled before anything is committed.
  const MONTHS = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const dtGet = el => { const v = el && el.getAttribute("data-ms"); return v ? +v : null; };
  function dtSet(el, ms) {
    if (!el) return;
    el.setAttribute("data-ms", ms == null ? "" : String(ms));
    el.classList.toggle("dsp-dtempty", ms == null);
    const v = el.querySelector(".dsp-dtval");
    if (v) v.textContent = ms == null ? (el.getAttribute("data-placeholder") || "not set") : fmtT(ms);
  }
  const dtFieldHTML = (id, placeholder) =>
    `<button type="button" class="dsp-dtfield dsp-dtempty" id="${id}" data-ms="" data-placeholder="${esc(placeholder)}">` +
    `<span class="dsp-dtcal">\u{1F4C5}</span><span class="dsp-dtval">${esc(placeholder)}</span></button>`;
  const hhmm = d => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  function closePicker() {
    const p = document.getElementById("dsp-pop");
    if (p) p.remove();
    document.removeEventListener("mousedown", outsidePicker, true);
    document.removeEventListener("keydown", escPicker, true);
  }
  function outsidePicker(e) {
    const p = document.getElementById("dsp-pop");
    if (p && !p.contains(e.target)) closePicker();
  }
  function escPicker(e) { if (e.key === "Escape") closePicker(); }
  // anchor: the field that was clicked. onPick(ms | null) — null means cleared.
  function openPicker(anchor, valueMs, onPick) {
    closePicker();
    // Default to 5pm today rather than midnight: nobody's deadline is 00:00,
    // and a picker that opens on a useless value costs two extra taps.
    let sel = valueMs ? new Date(valueMs) : (() => { const d = new Date(); d.setHours(17, 0, 0, 0); return d; })();
    let view = new Date(sel.getFullYear(), sel.getMonth(), 1);
    const pop = document.createElement("div");
    pop.id = "dsp-pop";
    pop.className = "dsp-pop";
    document.body.appendChild(pop);

    function draw() {
      const first = new Date(view.getFullYear(), view.getMonth(), 1);
      const lead = first.getDay();                                  // 0 = Sunday, matching the hours editor
      const cells = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(view.getFullYear(), view.getMonth(), 1 - lead + i);
        const other = d.getMonth() !== view.getMonth();
        const isSel = sameDay(d.getTime(), sel.getTime());
        const isToday = sameDay(d.getTime(), Date.now());
        cells.push(`<button type="button" class="dsp-pd${other ? " dsp-pdo" : ""}${isSel ? " dsp-pdsel" : ""}${isToday ? " dsp-pdtoday" : ""}" ` +
          `data-d="${d.getFullYear()}-${d.getMonth()}-${d.getDate()}">${d.getDate()}</button>`);
      }
      pop.innerHTML = `
        <div class="dsp-phead">
          <button type="button" class="dsp-pnav" data-mv="-1">‹</button>
          <span class="dsp-pmon">${esc(MONTHS[view.getMonth()])} ${view.getFullYear()}</span>
          <button type="button" class="dsp-pnav" data-mv="1">›</button>
        </div>
        <div class="dsp-pdow">${["S", "M", "T", "W", "T", "F", "S"].map(x => `<span>${x}</span>`).join("")}</div>
        <div class="dsp-pgrid">${cells.join("")}</div>
        <div class="dsp-ptime">
          <span class="dsp-pclock">\u{1F551}</span>
          <input type="time" class="dsp-ptin" value="${hhmm(sel)}">
          <span class="dsp-pchips">
            ${[["09:00", "9a"], ["12:00", "12p"], ["17:00", "5p"], ["23:59", "EOD"]]
              .map(([v, l]) => `<button type="button" class="dsp-pchip" data-t="${v}">${l}</button>`).join("")}
          </span>
        </div>
        <div class="dsp-pfoot">
          <button type="button" class="dsp-pclear" data-act="clear">Clear</button>
          <span class="dsp-ppreview">${esc(fmtT(sel.getTime()))}</span>
          <button type="button" class="dsp-pset" data-act="set">Set</button>
        </div>`;
      pop.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => {
        view = new Date(view.getFullYear(), view.getMonth() + (+b.dataset.mv), 1); draw();
      });
      pop.querySelectorAll("[data-d]").forEach(b => b.onclick = () => {
        const [y, m, dd] = b.dataset.d.split("-").map(Number);
        sel = new Date(y, m, dd, sel.getHours(), sel.getMinutes(), 0, 0);
        view = new Date(y, m, 1);
        draw();
      });
      const tin = pop.querySelector(".dsp-ptin");
      tin.onchange = tin.oninput = () => {
        const [h, mi] = String(tin.value || "").split(":").map(Number);
        if (Number.isFinite(h) && Number.isFinite(mi)) { sel.setHours(h, mi, 0, 0); draw(); }
      };
      pop.querySelectorAll("[data-t]").forEach(b => b.onclick = () => {
        const [h, mi] = b.dataset.t.split(":").map(Number);
        sel.setHours(h, mi, 0, 0); draw();
      });
      pop.querySelector('[data-act="clear"]').onclick = () => { closePicker(); onPick(null); };
      pop.querySelector('[data-act="set"]').onclick = () => { closePicker(); onPick(sel.getTime()); };
    }
    draw();
    // Anchor under the field, then pull it back inside the viewport. On a phone
    // the field is often near the right edge and a naive left:rect.left runs
    // the calendar off screen.
    const r = anchor.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 16);
    pop.style.width = w + "px";
    let left = Math.min(r.left, window.innerWidth - w - 8);
    pop.style.left = Math.max(8, left) + "px";
    const below = window.innerHeight - r.bottom;
    if (below > pop.offsetHeight + 12 || below > 300) pop.style.top = (r.bottom + 6) + "px";
    else pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + "px";
    setTimeout(() => {
      document.addEventListener("mousedown", outsidePicker, true);
      document.addEventListener("keydown", escPicker, true);
    }, 0);
  }

  // ---- mount ----------------------------------------------------------------
  function mount(el) {
    EL = el;
    el.innerHTML = `
    <style>
      .dsp-wrap{padding:6px 0}
      .dsp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
      .dsp-row input,.dsp-row select{font:inherit;padding:6px 8px;border-radius:6px;border:1px solid var(--line, #444);background:var(--panel, #1b1e24);color:inherit}
      .dsp-row button,.dsp-clear{font:inherit;font-size:13px;padding:6px 12px;border:1px solid var(--line, #666);border-radius:6px;background:var(--panel-2, #23262d);color:inherit;cursor:pointer}
      .dsp-hoursbar{margin:6px 0}
      .dsp-toggle{font:inherit;font-size:12.5px;padding:6px 12px;border:1px solid var(--line-soft, #333);border-radius:8px;background:var(--panel, #1b1e24);color:var(--ink-dim, #aab);cursor:pointer;text-align:left;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-toggle b{color:var(--signal, #FFB200)}
      .dsp-days{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}
      .dsp-wins{display:flex;flex-direction:column;gap:3px}
      .dsp-win{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
      .dsp-win b{cursor:pointer;color:var(--bad, #a55);font-size:13px;padding:4px 7px;line-height:1}
      .dsp-addwin{font:inherit;font-size:11px;padding:2px 7px;border:1px dashed var(--line, #4a4f57);border-radius:5px;background:transparent;color:var(--ink-faint, #889);cursor:pointer}
      .dsp-day{display:flex;flex-direction:column;gap:4px;padding:7px 9px;border:1px solid var(--line-soft, #2f333a);border-radius:8px;font-size:12px;flex:1 1 240px;min-width:0;max-width:340px}
      .dsp-day.dsp-ov{border-color:var(--signal, #FFB200)}
      .dsp-day input[type=time]{font-size:12px;padding:4px 6px;border-radius:5px;border:1px solid var(--line, #444);background:var(--panel, #1b1e24);color:inherit;width:auto;min-width:112px;flex:1 1 auto;box-sizing:content-box}
      .dsp-chipbox{min-height:56px;border:1px dashed var(--line, #3a3f47);border-radius:8px;padding:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .dsp-chipbox.dsp-over{border-color:var(--ok, #4cd07a);background:#12281a}
      #dsp-drop{display:none;position:absolute;inset:0;z-index:9;align-items:center;justify-content:center;background:rgba(18,40,26,.82);border:2px dashed var(--ok, #4cd07a);border-radius:12px;pointer-events:none}
      #dsp-drop div{font-size:16px;font-weight:700;color:var(--ok, #4cd07a)}
      .dsp-cname{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-q{font:inherit;font-size:13px;line-height:1;width:24px;height:24px;border:1px solid var(--line, #4a4f57);border-radius:5px;background:var(--panel, #1b1e24);color:inherit;cursor:pointer;padding:0}
      .dsp-qty{width:46px;font:inherit;font-size:12.5px;padding:2px 4px;text-align:center;border:1px solid var(--line, #444);border-radius:5px;background:var(--chassis, #12151a);color:inherit}
      .dsp-bump{outline:2px solid var(--ok, #4cd07a)}
      .dsp-chip{display:inline-flex;align-items:center;gap:5px;background:var(--panel-2, #23262d);border:1px solid var(--line, #444);border-radius:14px;padding:4px 10px;font-size:12.5px}
      .dsp-chip b{margin-left:7px;cursor:pointer;color:var(--bad, #c66)}
      .dsp-hinttext{color:var(--ink-faint, #778);font-size:12px}
      .dsp-job{display:flex;gap:12px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--line-soft, #2a2d33);font-size:13px;flex-wrap:wrap}
      .dsp-inbundle{padding-left:26px}
      .dsp-bundle{border:1px solid var(--line, #34383f);border-radius:8px;margin:8px 0;overflow:hidden}
      .dsp-bhead{display:flex;gap:12px;align-items:center;background:var(--panel-2, #1e2127);padding:7px 10px;font-size:13px;font-weight:700}
      .dsp-bhead span{color:var(--ink-dim, #9aa);font-weight:400}
      .dsp-bhead button{margin-left:auto}
      .dsp-jfile{font-weight:700;min-width:180px}
      .dsp-jstate{color:var(--ink-dim, #9aa)}
.dsp-jmissing{font-family:var(--mono);font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--bad,#F26B5E);border:1px solid color-mix(in srgb,var(--bad,#F26B5E) 55%,transparent);border-radius:9px;padding:1px 6px;margin-left:6px;vertical-align:middle}
.dsp-job.dsp-filemissing .dsp-jfile{color:var(--ink-dim,#9aa)}
      .dsp-done{opacity:.55}
      /* v2.22 priority picker in the job list. Compact; color-cued so a P5
         (top) and a P1 (low) read at a glance without opening anything. */
      .dsp-jprio{font:inherit;font-size:12px;padding:2px 4px;border:1px solid var(--line,#3C4250);
        border-radius:5px;background:var(--chassis,#12151a);color:var(--ink-dim,#AEB6C4);cursor:pointer}
      .dsp-jprio.dsp-prio5{border-color:var(--signal,#FFB200);color:var(--signal,#FFB200);font-weight:700}
      .dsp-jprio.dsp-prio4{border-color:color-mix(in srgb, var(--signal,#FFB200) 55%, var(--line,#3C4250))}
      .dsp-jprio.dsp-prio1,.dsp-jprio.dsp-prio2{color:var(--ink-faint,#828B9A)}
      /* v2.22: a job that is printing right now gets the same green cue as its
         printer's lane, so the two views agree at a glance. */
      .dsp-job.dsp-printing{box-shadow:inset 3px 0 0 var(--ok,#3DD68C);
        background:color-mix(in srgb, var(--ok,#3DD68C) 7%, transparent)}
      .dsp-job.dsp-printing .dsp-jstate{color:var(--ok,#3DD68C);font-weight:700}
      .dsp-swatches i{display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid #0006;margin-right:2px;vertical-align:middle}
      .dsp-job button,.dsp-bhead button{font-size:12px;padding:3px 9px;border:1px solid var(--line, #555);border-radius:5px;background:var(--panel-2, #23262d);color:inherit;cursor:pointer}
      /* .dsp-lane/.dsp-track/.dsp-blk went with the percentage-width timeline
         the guide replaced in v2.15 — don't reintroduce them. */
      .dsp-clear{border-color:#0a7a33;color:var(--ok, #4cd07a);font-size:11.5px;padding:3px 8px;align-self:flex-start}
      .dsp-idleclear{border-color:var(--line, #555);color:var(--ink-dim, #9aa)}
    /* v2.19 maintenance. Reads as neither "running" green nor "fault" red:
       taking a machine down is a decision, not an incident. */
    .dsp-maint{font:inherit;font-size:11.5px;padding:3px 8px;align-self:flex-start;
      border:1px dashed var(--line,#3C4250);border-radius:var(--r-sm,6px);
      background:transparent;color:var(--ink-faint,#828B9A);cursor:pointer;white-space:nowrap}
    .dsp-maint:hover{color:var(--ink,#F4F6FA);border-color:var(--ink-faint,#828B9A)}
    .dsp-maint-on{border-style:solid;color:var(--signal,#FFB200);
      border-color:color-mix(in srgb, var(--signal,#FFB200) 55%, var(--line,#3C4250))}
    .dsp-gmaint{color:var(--signal,#FFB200);font-weight:700}
    /* The whole lane recedes, so the eye reads "this machine is not in play"
       before it reads any of the words. The bars still draw: a print already on
       the bed is still real and still occupies the machine. */
    .dsp-rowmaint .dsp-gtime{opacity:.42}
    .dsp-rowmaint .dsp-gpname{color:var(--ink-dim,#AEB6C4)}
      .dsp-swapn{color:#ffd166;font-weight:700}
      .dsp-idle{color:var(--busy, #8ab);font-weight:700;margin-left:4px}
      .dsp-lidle{color:var(--ink-faint, #667);font-weight:400;font-size:11.5px}
      #dsp-sheet{display:none;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.62);align-items:center;justify-content:center;padding:16px}
      .dsp-sheetbox{background:var(--panel, #161920);border:1px solid var(--line, #343941);border-radius:12px;padding:16px;max-width:440px;width:100%;max-height:80vh;overflow:auto}
      .dsp-sheettitle{font-size:15px;font-weight:800;margin-bottom:10px;word-break:break-word}
      .dsp-sheettab{width:100%;font-size:13px;border-collapse:collapse}
      .dsp-sheettab td{padding:4px 0;vertical-align:top}
      .dsp-sheettab td:first-child{color:var(--ink-faint, #889);width:96px}
      .dsp-sheetsub{margin:12px 0 4px;font-size:11.5px;letter-spacing:.07em;color:var(--signal, #FFB200);font-weight:800}
      .dsp-anyslot{color:var(--ink-faint, #889);font-weight:400;letter-spacing:0;text-transform:none}
      .dsp-mounts{list-style:none;padding:0;margin:0;font-size:13px}
      .dsp-mounts li{display:flex;align-items:center;gap:8px;padding:3px 0}
      .dsp-mounts i{width:15px;height:15px;border-radius:4px;border:1px solid #0006;flex:none}
      .dsp-sheetclose{margin-top:14px;width:100%;font:inherit;font-size:13px;padding:9px;border:1px solid var(--line, #555);border-radius:8px;background:var(--panel-2, #23262d);color:inherit;cursor:pointer}
      .dsp-blk{cursor:pointer}
      .dsp-clash{color:#ff9f43;font-weight:800;margin-left:4px}
      .dsp-moverow{display:flex;gap:6px;margin-top:4px}
      .dsp-moveto{flex:1;font:inherit;font-size:13px;padding:7px;border:1px solid var(--line, #444);border-radius:7px;background:var(--panel, #1b1e24);color:inherit}
      .dsp-movego{font:inherit;font-size:13px;padding:7px 14px;border:1px solid var(--line, #555);border-radius:7px;background:var(--panel-2, #23262d);color:inherit;cursor:pointer}
      .dsp-targetbar{border:1px solid var(--line-soft, #2f333a);border-radius:8px;padding:7px 10px;font-size:12.5px}
      .dsp-targetbar span{color:var(--ink-dim, #c9cbd1)}
      .dsp-rep{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 11px;border-radius:8px;font-size:13px;margin:6px 0}
      .dsp-rep span{color:var(--ink-dim, #9aa);font-weight:400}
      .dsp-rep-ok{background:#12261a;border:1px solid #2c6b41;color:#8fe0ac}
      .dsp-rep-bad{background:#2a1414;border:1px solid #8a3b32;color:#f0a89f}
      .dsp-rep-none{background:var(--panel, #1b1e24);border:1px solid var(--line-soft, #2f333a);color:var(--ink-faint, #889)}
      .dsp-repmore{margin-left:auto;font:inherit;font-size:12px;padding:3px 10px;border:1px solid #7a4c46;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
      .dsp-replist{border:1px solid var(--line-soft, #2a2d33);border-radius:8px;overflow:hidden;margin-bottom:8px}
      .dsp-repitem{padding:8px 11px;border-bottom:1px solid var(--panel-2, #23262d);font-size:12.5px}
      .dsp-repitem:last-child{border-bottom:0}
      .dsp-repline{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
      .dsp-repfile{font-weight:700}
      .dsp-repfile i{color:var(--ink-faint, #889);font-style:normal;font-weight:400}
      .dsp-replate{color:#f0a89f;font-weight:700}
      .dsp-repwhere{color:var(--ink-faint, #889)}
      .dsp-repcause{margin-left:auto;color:#ffd166;font-size:11.5px;border:1px solid #5c4a1f;border-radius:10px;padding:1px 8px}
      .dsp-repwhy{color:var(--ink-dim, #b9bcc4);margin-top:4px;line-height:1.45}
      .dsp-repfix{color:#8fb7e0;margin-top:3px;line-height:1.45}
      .dsp-repnote{color:#ff9f43;margin-top:3px}
      .dsp-empty{color:var(--ink-faint, #889);font-size:13px;padding:10px 2px}
      .dsp-h{font-size:12px;letter-spacing:.08em;color:var(--signal, #FFB200);font-weight:800;margin:14px 0 4px}
      /* ---- the guide (v2.15) --------------------------------------------- */
      /* One scale governs everything: distance is time. The channel column and
         the ruler are sticky so you never lose the machine or the day. */
      .dsp-gtools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0 4px}
      .dsp-gsub{color:var(--ink-faint,#828B9A);font-size:11.5px}
      .dsp-gz,.dsp-gjump{font:inherit;font-size:11.5px;padding:3px 9px;border:1px solid var(--line,#3C4250);border-radius:6px;background:var(--panel,#1b1e24);color:var(--ink-dim,#AEB6C4);cursor:pointer}
      .dsp-gzon{border-color:var(--signal, #FFB200);color:var(--signal, #FFB200);font-weight:700}
      /* v2.22 fluid/locked toggle. Fluid reads calm; locked reads deliberate
         (solid amber, the "you decided this" color used for maintenance). */
      .dsp-glock{font:inherit;font-size:11.5px;padding:3px 10px;border:1px solid var(--line,#3C4250);
        border-radius:6px;background:var(--panel,#1b1e24);color:var(--ink-dim,#AEB6C4);cursor:pointer;white-space:nowrap}
      .dsp-glock:hover{border-color:var(--ink-faint,#828B9A);color:var(--ink,#F4F6FA)}
      .dsp-glock-on{border-color:var(--signal,#FFB200);color:var(--signal,#FFB200);font-weight:700;
        background:color-mix(in srgb, var(--signal,#FFB200) 12%, var(--panel,#1b1e24))}
      .dsp-gnewlock{font-size:11px;color:var(--signal,#FFB200);white-space:nowrap;cursor:default}
      .dsp-gkey{display:flex;gap:8px;align-items:center;margin-left:auto;color:var(--ink-faint,#828B9A);font-size:11px;flex-wrap:wrap}
      .dsp-gkey i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:3px;vertical-align:-1px}
      .dsp-krun{background:#1d5c3a;border:1px solid var(--ok,#3DD68C)}
      .dsp-kblk{background:#274a72;border:1px solid #3a6ca8}
      .dsp-kmiss{background:#6e2020;border:1px solid #c0392b}
      .dsp-kclosed{background:repeating-linear-gradient(45deg,#171a20,#171a20 3px,var(--chassis, #12151a) 3px,var(--chassis, #12151a) 6px);border:1px solid var(--panel-2, #23262d)}
      .dsp-guide{overflow-x:auto;overflow-y:hidden;border:1px solid var(--line-soft,#2a2d33);border-radius:9px;background:var(--chassis,#12151a);-webkit-overflow-scrolling:touch}
      .dsp-gtrack{position:relative}
      .dsp-grow{display:flex;align-items:stretch;border-bottom:1px solid var(--line-soft,#23262d)}
      .dsp-grow:last-child{border-bottom:0}
      .dsp-gcell{position:sticky;left:0;z-index:3;width:132px;min-width:132px;flex:none;
        display:flex;flex-direction:column;gap:2px;justify-content:center;padding:6px 9px;
        background:var(--panel,#1b1e24);border-right:1px solid var(--line,#3C4250)}
      .dsp-gpname{font-size:12.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-gtime{position:relative;flex:none;height:46px}
      .dsp-gruler{position:sticky;top:0;z-index:4;background:var(--panel,#1b1e24)}
      .dsp-gruler .dsp-gtime{height:38px}
      .dsp-gcorner{justify-content:flex-end;padding-bottom:5px}
      .dsp-gday{position:absolute;top:0;height:17px;line-height:17px;border-left:1px solid var(--line,#3C4250);
        background:var(--panel-2,#23262d);font-size:11px;font-weight:800;letter-spacing:.04em;
        color:var(--signal, #FFB200);overflow:hidden;white-space:nowrap}
      .dsp-gday span{padding-left:6px}
      .dsp-gtick{position:absolute;top:17px;bottom:0;border-left:1px solid var(--line-soft,#23262d)}
      .dsp-gtick.dsp-gmid{border-left-color:var(--line,#3C4250)}
      .dsp-gtick span{position:absolute;left:3px;top:2px;font-size:10.5px;color:var(--ink-faint,#828B9A);white-space:nowrap}
      /* closed hours sit behind everything and never intercept a tap */
      .dsp-gtime > i{position:absolute;top:0;bottom:0;pointer-events:none;
        background:repeating-linear-gradient(45deg,rgba(255,255,255,.028),rgba(255,255,255,.028) 3px,transparent 3px,transparent 6px)}
      .dsp-gnow{position:absolute;top:0;bottom:0;width:2px;background:var(--signal,#FFB200);opacity:.85;pointer-events:none;z-index:2}
      .dsp-gblk{position:absolute;top:4px;bottom:4px;z-index:1;background:#274a72;border:1px solid #3a6ca8;border-radius:5px;
        padding:0 5px;overflow:hidden;cursor:pointer;display:flex;align-items:center;gap:4px;
        transition:filter var(--dur,.18s) var(--ease,ease)}
      .dsp-gblk:hover{filter:brightness(1.18)}
      .dsp-gmiss{background:#6e2020;border-color:#c0392b}
      /* Running now: green, and visibly not one of the planned blue blocks —
         it is the one thing on the guide that is already true. */
      .dsp-grun{position:absolute;top:4px;bottom:4px;z-index:1;background:#1d5c3a;border:1px solid var(--ok,#3DD68C);
        border-radius:5px;padding:0 5px;overflow:hidden;cursor:pointer;display:flex;align-items:center;gap:4px}
      .dsp-grun:hover{filter:brightness(1.18)}
      .dsp-grun .dsp-gtext span{color:#bff0d4}
      .dsp-grunicon{flex:none;font-size:10px;color:var(--ok,#3DD68C)}
      .dsp-grunp{background:#5c4a1d;border-color:var(--signal, #FFB200)}
      .dsp-grunp .dsp-grunicon{color:var(--signal, #FFB200)}
      /* ETA unknown: striped, so an 8-hour pessimistic bar never reads as a measurement */
      .dsp-grunq{background:repeating-linear-gradient(45deg,#1d5c3a,#1d5c3a 6px,#164a2e 6px,#164a2e 12px)}
      .dsp-grunning{color:var(--ok,#3DD68C);font-weight:700}
      /* v2.22 (Danny): highlight the whole row of a printer that is PRINTING
         NOW, so "which machines are going" reads at a glance even when the
         "printing now" label is clipped in the narrow name cell. A green left
         rail + a faint tint + a pill that can't be truncated. */
      .dsp-rowrun{background:color-mix(in srgb, var(--ok,#3DD68C) 8%, transparent);
        box-shadow:inset 3px 0 0 var(--ok,#3DD68C)}
      .dsp-rowrun .dsp-gcell{background:color-mix(in srgb, var(--ok,#3DD68C) 12%, var(--panel,#1b1e24));
        border-right-color:color-mix(in srgb, var(--ok,#3DD68C) 40%, var(--line,#3C4250))}
      .dsp-rowrun .dsp-gpname{color:var(--ok,#3DD68C)}
      .dsp-grunning{display:inline-block;align-self:flex-start;color:var(--chassis,#12151a);font-weight:800;
        background:var(--ok,#3DD68C);border-radius:10px;padding:1px 8px;font-size:11px;max-width:100%;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-gtext{display:flex;flex-direction:column;justify-content:center;min-width:0;line-height:1.2;overflow:hidden}
      .dsp-gtext b{font-size:11.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsp-gtext span{font-size:10px;color:#cfe0f5;opacity:.85;white-space:nowrap}
      .dsp-gblk b.dsp-swapn,.dsp-gblk b.dsp-clash,.dsp-gblk b.dsp-idle{flex:none;font-size:10.5px}
      /* ---- replan progress + change list ---------------------------------- */
      .dsp-pbar{margin:6px 0}
      .dsp-pbtrack{height:4px;border-radius:3px;background:var(--panel-2,#23262d);overflow:hidden}
      .dsp-pbfill{height:100%;width:0;background:var(--signal, #FFB200);transition:width .22s var(--ease,ease)}
      .dsp-pblabel{font-size:11.5px;color:var(--ink-faint,#828B9A);margin-top:4px}
      .dsp-pbbad .dsp-pbfill{background:var(--bad,#F26B5E)}
      .dsp-pbbad .dsp-pblabel{color:var(--bad,#F26B5E)}
      .dsp-chg{display:flex;gap:8px;align-items:center;padding:7px 11px;border:1px solid var(--line,#3C4250);
        border-radius:8px 8px 0 0;background:var(--panel,#1b1e24);font-size:13px}
      .dsp-chg span{color:var(--ink-faint,#828B9A);font-weight:400}
      .dsp-chgnone{border-radius:8px;color:var(--ink-dim,#AEB6C4)}
      .dsp-chgx{margin-left:auto;font:inherit;font-size:12px;line-height:1;padding:3px 7px;border:1px solid var(--line,#3C4250);
        border-radius:5px;background:transparent;color:inherit;cursor:pointer}
      .dsp-chglist{border:1px solid var(--line,#3C4250);border-top:0;border-radius:0 0 8px 8px;overflow:hidden;margin-bottom:8px}
      .dsp-chgrow{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;padding:6px 11px;font-size:12.5px;
        border-bottom:1px solid var(--line-soft,#23262d);border-left:3px solid transparent}
      .dsp-chgrow:last-child{border-bottom:0}
      .dsp-chgfile{font-weight:700;min-width:150px}
      .dsp-chgfile i{color:var(--ink-faint,#828B9A);font-style:normal;font-weight:400}
      .dsp-chgtext{color:var(--ink-dim,#AEB6C4)}
      .dsp-k-nowmiss{border-left-color:#c0392b} .dsp-k-nowmiss .dsp-chgtext{color:#f0a89f;font-weight:700}
      .dsp-k-gone{border-left-color:#7a4c46}
      .dsp-k-later{border-left-color:#c07a2b}
      .dsp-k-moved{border-left-color:#3a6ca8}
      .dsp-k-new{border-left-color:#2c6b41}
      .dsp-k-earlier{border-left-color:#2c6b41}
      .dsp-k-nowmakes{border-left-color:#2c6b41} .dsp-k-nowmakes .dsp-chgtext{color:#8fe0ac}
      /* ---- date + time field and flyout ----------------------------------- */
      .dsp-dtfield{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;
        padding:6px 10px;border:1px solid var(--line,#444);border-radius:6px;background:var(--panel,#1b1e24);
        color:inherit;cursor:pointer;min-width:170px;text-align:left}
      .dsp-dtfield:hover{border-color:var(--signal, #FFB200)}
      .dsp-dtempty .dsp-dtval{color:var(--ink-faint,#828B9A)}
      .dsp-dtcal{font-size:12px;opacity:.85}
      .dsp-pop{position:fixed;z-index:70;background:var(--panel,#161920);border:1px solid var(--line,#343941);
        border-radius:12px;padding:10px;box-shadow:var(--elev-2,0 10px 28px rgba(0,0,0,.5));font-size:13px}
      .dsp-phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
      .dsp-pmon{font-weight:800;font-size:13px}
      .dsp-pnav{font:inherit;font-size:16px;line-height:1;width:28px;height:28px;border:1px solid var(--line,#3C4250);
        border-radius:6px;background:transparent;color:inherit;cursor:pointer}
      .dsp-pdow{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:2px}
      .dsp-pdow span{text-align:center;font-size:10.5px;color:var(--ink-faint,#828B9A)}
      .dsp-pgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
      .dsp-pd{font:inherit;font-size:12px;height:30px;border:1px solid transparent;border-radius:6px;
        background:transparent;color:inherit;cursor:pointer}
      .dsp-pd:hover{background:var(--panel-2,#23262d)}
      .dsp-pdo{color:var(--ink-faint,#5C6474)}
      .dsp-pdtoday{border-color:var(--line,#3C4250)}
      .dsp-pdsel{background:var(--signal, #FFB200);color:var(--chassis, #12151a);font-weight:800;border-color:var(--signal, #FFB200)}
      .dsp-ptime{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px;padding-top:9px;
        border-top:1px solid var(--line-soft,#2a2d33)}
      .dsp-pclock{font-size:13px}
      .dsp-ptin{font:inherit;font-size:12.5px;padding:5px 7px;border:1px solid var(--line,#444);border-radius:6px;
        background:var(--chassis,#12151a);color:inherit}
      .dsp-pchips{display:flex;gap:3px;flex-wrap:wrap}
      .dsp-pchip{font:inherit;font-size:11px;padding:4px 7px;border:1px solid var(--line,#3C4250);border-radius:11px;
        background:transparent;color:var(--ink-dim,#AEB6C4);cursor:pointer}
      .dsp-pchip:hover{border-color:var(--signal, #FFB200);color:var(--signal, #FFB200)}
      .dsp-pfoot{display:flex;align-items:center;gap:8px;margin-top:9px;padding-top:9px;border-top:1px solid var(--line-soft,#2a2d33)}
      .dsp-ppreview{flex:1;font-size:11.5px;color:var(--ink-faint,#828B9A);text-align:center}
      .dsp-pclear,.dsp-pset{font:inherit;font-size:12.5px;padding:6px 12px;border-radius:7px;cursor:pointer;border:1px solid var(--line,#555)}
      .dsp-pclear{background:transparent;color:var(--ink-dim,#AEB6C4)}
      .dsp-pset{background:var(--signal, #FFB200);border-color:var(--signal, #FFB200);color:var(--chassis, #12151a);font-weight:800}
      @media (max-width:560px){
        .dsp-gcell{width:104px;min-width:104px;padding:5px 7px}
        .dsp-chgfile{min-width:0}
      }
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
        <div style="color:var(--ink-faint, #889);font-size:12px;margin:2px 0 6px">Jobs always START inside these hours - that is when you are around to swap spools and clear beds. Add a second block for days you're out in the middle. • = overridden day. Auto-start stays off — a human taps "Bed cleared".</div>
        <div class="dsp-days" id="dsp-days"></div>
      </div>
      <div class="dsp-row dsp-targetbar">
        <span title="One deadline for the whole queue. Jobs with a deadline of their own keep it.">🎯 Finish everything by</span>
        ${dtFieldHTML("dsp-target", "pick a date and time")}
        <button id="dsp-target-clear" style="display:none">Clear</button>
      </div>
      <div class="dsp-h">ADD JOB <span style="color:var(--ink-faint, #889);font-weight:400">— several files become one bundle (multi-plate prints)</span></div>
      <div class="dsp-row">
        <select id="dsp-file"></select><button id="dsp-stage">+ add file</button>
        deadline ${dtFieldHTML("dsp-dl", "none")}
        <label title="Plan this one to finish while you are around (delicate removal, same-day shipping)"><input type="checkbox" id="dsp-on"> be here at the finish</label>
        <input id="dsp-bundlename" placeholder="bundle name (e.g. Jones order)" style="display:none;min-width:200px">
        <button id="dsp-add">Add</button>
      </div>
      <div class="dsp-chipbox" id="dsp-chips"></div>
      <button id="dsp-jobs-toggle" class="dsp-toggle">JOBS <span id="dsp-jobs-sum"></span> <b id="dsp-jobs-caret">▾</b></button>
      <div id="dsp-jobs"></div>
      <div class="dsp-h">PLAN <button id="dsp-replan" style="font-size:11px;padding:2px 8px">↻ replan</button> <button id="dsp-adopt" style="font-size:11px;padding:2px 8px" title="Match prints already running on your printers to queued jobs, so Dispatch stops scheduling work the farm is already doing">⤓ claim running prints</button></div>
      <div class="dsp-pbar" id="dsp-progress" style="display:none">
        <div class="dsp-pbtrack"><div class="dsp-pbfill"></div></div>
        <div class="dsp-pblabel"></div>
      </div>
      <div id="dsp-changes"></div>
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
    // Farm target. The picker's own "Set" is the commit — a second Set button
    // beside it would only invite half-set targets. Errors surface: a target
    // that silently didn't save is worse than none, because the banner beneath
    // it would then be answering a question nobody asked.
    $$("#dsp-target").onclick = () => {
      const el = $$("#dsp-target");
      openPicker(el, dtGet(el), async ms => {
        const r = await jpost("/api/dispatch/settings", { target: ms });
        if (!r.ok) return alert((r.body && r.body.error) || "Could not set that target");
        REPOPEN = true;                    // they just asked the question — show the answer
        load();
      });
    };
    $$("#dsp-target-clear").onclick = async () => {
      await jpost("/api/dispatch/settings", { target: null });
      load();
    };
    $$("#dsp-dl").onclick = () => {
      const el = $$("#dsp-dl");
      openPicker(el, dtGet(el), ms => dtSet(el, ms));
    };
    $$("#dsp-stage").onclick = () => addChip($$("#dsp-file").value);
    $$("#dsp-add").onclick = async () => {
      if (!FILEQ.length && $$("#dsp-file").value) addChip($$("#dsp-file").value);
      if (!FILEQ.length) return;
      const dl = dtGet($$("#dsp-dl"));
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
      else { FILEQ = []; $$("#dsp-bundlename").value = ""; dtSet($$("#dsp-dl"), null); $$("#dsp-on").checked = false; }
      load();
    };
    $$("#dsp-replan").onclick = replan;
    $$("#dsp-adopt").onclick = async () => {
      const b = $$("#dsp-adopt"), was = b.textContent;
      b.disabled = true; b.textContent = "\u2026";
      const r = await jpost("/api/dispatch/adopt", {});
      b.disabled = false; b.textContent = was;
      const ad = (r.body && r.body.adopted) || [];
      const al = (r.body && r.body.already) || [];
      const un = (r.body && r.body.unmatched) || [];
      const rl = (r.body && r.body.released) || [];
      const lines = [];
      // Letting go is half of "match reality", and it changes what the planner
      // thinks the farm has free — so it gets reported first, with the evidence.
      if (rl.length) lines.push("Released " + rl.length + " stale claim" + (rl.length > 1 ? "s" : "") +
        " (the printer says otherwise):\n" +
        rl.map(x => "  • " + x.file + " claimed " + x.printer + ", which is " +
          (x.printer_file ? x.printer_state + " '" + x.printer_file + "'" : x.printer_state)).join("\n"));
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
