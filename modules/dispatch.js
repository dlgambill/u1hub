// modules/dispatch.js — the scheduler (v2.11; completion target v2.13).
// PrintFarm's workflow, reborn as
// a Hub module on state the Hub actually KNOWS instead of guesses:
//   * swap minimization reads real tray colors (print_task_config via the
//     fleet snapshot) plus physical spool identity (the shelf), so the plan
//     says "mount Ash Gray sp_xxx on T2", not "probably grey-ish".
//   * the executor never starts a machine by itself: a human taps
//     "Bed cleared → start next" and the CLIENT fires the existing /api/print
//     path (class guard, mapping, filament memory all apply for free).
//     settings.auto_start is stored but refuses `true` until unattended
//     starting has passed its own hardware gate — Rule #1, doubly.
//   * deadline scheduling keeps PrintFarm's attended-window insight: jobs only
//     START inside the window and must FINISH inside it unless the job is
//     marked overnight_ok — long prints span the night on purpose, short ones
//     don't start at 21:50.
// Persistence: dispatch.json in the Hub's write-temp-then-rename idiom (the
// translation of PrintFarm's SQLite busy_timeout lesson). On the never-commit
// list. JS getDay(): 0 = SUNDAY — the Python weekday() (0=Monday) offset bug
// gets a named constant here, not a comment in a commit message.

"use strict";

const fs = require("fs");
const path = require("path");

const JS_SUNDAY = 0, JS_SATURDAY = 6;           // getDay(); Python's weekday() is 0=Monday
const BED_CLEAR_BUFFER_MIN = 5;                  // gap between planned jobs on one machine
const SWAP_COST_MIN = 20;                        // a filament swap is "worth" this much
                                                 // time when choosing between printers
const STICKY_TOLERANCE_MIN = 30;                 // keep a copy on the machine it had last
                                                 // plan unless another finishes it this
                                                 // much sooner (stability, not stickiness)
const PLAN_SLOT_CAP = 200;                       // sanity cap on plan expansion
const EXEC_TICK_MS = 10000;                      // completion watcher (probe caches make this cheap)

// ---- feasibility report (v2.13) ---------------------------------------------
// "Everything by Friday 5pm — what makes it, and what doesn't?"
//
// A list of red blocks is not an answer. The useful half is WHY a copy is late,
// because every cause has a different move: a machine you could free, a bed you
// could clear, an hour of attendance you could add, or a print that was never
// going to fit no matter what. So each miss is attributed to the single largest
// wait between now and its start, and told what recovering that wait would buy.
//
// Deliberately a PURE function of the slots plan() already produced — no second
// plan() run, no clock of its own. A report that re-planned could disagree with
// the timeline drawn next to it, and then neither would be believed.
// Weekday + time alone is a trap: "Tue 08:00" reads as tomorrow whether it is
// tomorrow or a fortnight out, and this prose is exactly where the difference
// decides whether you act. Always carry the date (v2.15).
const FMT_T = ms => new Date(ms).toLocaleString([],
  { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const DUR = m => {
  m = Math.max(0, Math.round(m));
  return m >= 60 ? Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m";
};
function feasibility(slots, target, now) {
  const good = slots.filter(s => !s.unplannable);
  const bad = slots.filter(s => s.unplannable);
  const items = [];
  // A copy that cannot be scheduled at all is a miss of the worst kind: it has
  // no finish time to be late against. Report it first, never silently.
  for (const s of bad) items.push({
    job_id: s.job_id, file: s.file, copy: s.copy, of: s.of,
    cause: "unplannable", late_min: null, cause_detail: s.unplannable,
    fix: "This copy has no place in the plan at all — settle that before the deadline question means anything."
  });
  for (const s of good) {
    if (!s.deadline || s.est_end <= s.deadline) continue;
    const late = Math.round((s.est_end - s.deadline) / 60000);
    const d = s.delay || {};
    const left = Math.round((s.deadline - now) / 60000);       // minutes from now to its deadline
    let cause, detail, fix;
    if (s.est_minutes > left) {
      // No wait to blame: the run alone overshoots. An idle farm wouldn't help.
      cause = "too_long";
      detail = "The print runs " + DUR(s.est_minutes) + " and only " + DUR(left) +
               " remain before its deadline — no machine, however free, finishes it in time.";
      fix = "Move the deadline out by at least " + DUR(late) + ", drop this copy, or split the plate.";
    } else {
      const waits = [
        { code: "queued_behind",  min: d.queue || 0 },
        { code: "bed_clear",      min: d.bed || 0 },
        { code: "printer_busy",   min: d.inflight || 0 },
        { code: "attended_hours", min: d.window || 0 }
      ].sort((a, b) => b.min - a.min);
      const top = waits[0];
      if (!top.min) {
        cause = "no_slack";
        detail = "It starts as early as the plan allows and still lands " + DUR(late) + " late.";
        fix = "Move the deadline " + DUR(late) + ", or take that much work out of the queue.";
      } else {
        cause = top.code;
        const ahead = s.queued_ahead || 1;
        detail =
          cause === "queued_behind" ? ahead + " cop" + (ahead === 1 ? "y" : "ies") + " ahead of it on " +
            s.printerName + " hold the machine — " + DUR(top.min) + " of waiting before it can start at " + FMT_T(s.est_start) + "." :
          cause === "bed_clear" ? s.printerName + " finishes its previous print well before this one starts, but a " +
            "human has to clear the bed — " + DUR(top.min) + " of that wait is a machine sitting done and full." :
          cause === "printer_busy" ? s.printerName + " is still running a print of its own until " +
            FMT_T(s.lane_free_at || s.est_start) + " — " + DUR(top.min) + " of waiting." :
          s.printerName + " is free earlier, but a job may only START inside your attended hours — it waits " +
            DUR(top.min) + " for the next block to open at " + FMT_T(s.est_start) + ".";
        const gain = top.min >= late
          ? "Recovering that wait alone would make it — you need " + DUR(late) + " of it."
          : "Recovering all of it still leaves " + DUR(late - top.min) + " to find elsewhere.";
        fix = ({
          queued_behind:  "Free capacity: another machine, or defer what is ahead of it. ",
          bed_clear:      "Be there to clear that bed sooner, or start the print earlier in the day. ",
          printer_busy:   "Wait it out, or move this copy to a machine that is already free. ",
          attended_hours: "Add an attended block covering " + FMT_T(s.est_start) +
                          " — a short one is enough, since only the START has to be inside it. "
        })[cause] + gain;
      }
    }
    items.push({
      job_id: s.job_id, file: s.file, copy: s.copy, of: s.of,
      printer: s.printer, printerName: s.printerName,
      queued_ahead: s.queued_ahead || 0,
      est_start: s.est_start, est_end: s.est_end,
      deadline: s.deadline, deadline_source: s.deadline_source,
      late_min: late, cause, cause_detail: detail, fix,
      // Contention never delays the plan (it is flagged, not serialised), so it
      // is a note on a miss, never its cause. Saying otherwise would be a lie
      // the user could act on.
      contention: s.contention ? s.contention.color + " also wanted by " + s.contention.file +
                                 " on " + s.contention.printer : undefined
    });
  }
  const rank = x => (x.late_min == null ? Infinity : x.late_min);
  items.sort((a, b) => rank(b) - rank(a));
  // Tightest margin anywhere in the plan — negative when something misses.
  // Measured per copy against ITS deadline, not plan-end against the target: a
  // job with its own later deadline running past the target is not a miss, and
  // a summary that said otherwise would cry wolf.
  const withDl = good.filter(s => s.deadline);
  const slack = withDl.length ? Math.min(...withDl.map(s => Math.round((s.deadline - s.est_end) / 60000))) : null;
  return {
    target: target || null,
    copies: slots.length,
    misses: items.length,
    makes: slots.length - items.length,
    unplannable: bad.length,
    judged: withDl.length,                        // copies that actually have a deadline to miss
    latest_end: good.length ? Math.max(...good.map(s => s.est_end)) : null,
    slack_min: slack,
    items: items.slice(0, 60)
  };
}

function register(ctx) {
  const FILE = path.join(ctx.baseDir, "dispatch.json");

  // ---- state + persistence --------------------------------------------------
  // Attended hours are a WEEK TEMPLATE (per day-of-week: available? start/end)
  // plus per-calendar-week overrides keyed by ISO week ("2026-W35") — set your
  // normal week once, adjust an unusual week without touching the template.
  const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];   // getDay() order (0 = Sunday)
  const DAY = (on, s, e) => ({ on: !!on, start: s, end: e });
  const DEFAULT_WEEK = {
    sun: DAY(true, "09:00", "22:00"), mon: DAY(true, "08:00", "22:00"),
    tue: DAY(true, "08:00", "22:00"), wed: DAY(true, "08:00", "22:00"),
    thu: DAY(true, "08:00", "22:00"), fri: DAY(true, "08:00", "22:00"),
    sat: DAY(true, "09:00", "22:00")
  };
  const DEFAULT_SETTINGS = {
    week: DEFAULT_WEEK,
    weekOverrides: {},                           // { "2026-W35": { mon: DAY, ... } } (partial ok)
    // legacy pair kept mirrored for older clients/readers of dispatch.json
    attended: { start: "08:00", end: "22:00" },
    weekend:  { start: "09:00", end: "22:00" },
    away: [],                                    // [{from: ms, to: ms}]
    finish_policy: "anytime",                    // "anytime" | "attended"
    // FARM TARGET (v2.13) — "I want everything done by this moment". One
    // datetime for the whole queue, because that is how a show or a customer
    // pickup actually arrives: not as 30 per-job deadlines typed by hand.
    // It is a FALLBACK, never an override — see deadlineOf() in plan().
    target: null,                                // ms, or null for "no target"
    // v2.22: fluid vs locked. "fluid" replans from scratch every call (the
    // original, and the default) so times slide as machines free up. "locked"
    // freezes the plan you were looking at — see D.frozen and plan() — so the
    // board stops reshuffling on refresh. Danny's call: the answer to "why did
    // everything move" is sometimes "hold still".
    schedule_mode: "fluid",                      // "fluid" | "locked"
    auto_start: false
  };
  // maintenance: { "<printerIdx>": { since, note } } — machines deliberately
  // taken out of service. v2.19. Keyed by printer INDEX, like printing_on and
  // the assign/clear-bed endpoints, so it lines up with the rest of the module.
  // v2.22: frozen holds the snapshot a "locked" schedule serves — the placed
  // slots from the plan at the moment you locked, kept still while running/
  // attended/printers stay live. null whenever the mode is fluid.
  let D = { jobs: [], bundles: [], maintenance: {}, frozen: null, settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    D.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    D.bundles = Array.isArray(raw.bundles) ? raw.bundles : [];
    D.frozen = (raw.frozen && Array.isArray(raw.frozen.slots)) ? raw.frozen : null;
    D.maintenance = (raw.maintenance && typeof raw.maintenance === "object" && !Array.isArray(raw.maintenance))
      ? raw.maintenance : {};
    D.settings = { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), ...(raw.settings || {}), auto_start: false };
    // pre-week dispatch.json: build the week from the legacy attended/weekend pair
    if (!raw.settings || !raw.settings.week) {
      const at = D.settings.attended, wk = D.settings.weekend;
      D.settings.week = {};
      for (const k of DAY_KEYS) D.settings.week[k] =
        (k === "sat" || k === "sun") ? DAY(true, wk.start, wk.end) : DAY(true, at.start, at.end);
    }
    if (typeof D.settings.weekOverrides !== "object" || !D.settings.weekOverrides) D.settings.weekOverrides = {};
  } catch {}
  // A locked mode with no snapshot to serve is just fluid wearing the wrong
  // label — normalise so plan() never has to second-guess it.
  if (D.settings.schedule_mode !== "locked") D.settings.schedule_mode = "fluid";
  if (D.settings.schedule_mode === "locked" && !D.frozen) D.settings.schedule_mode = "fluid";
  // Priority is a 1-5 scale, 5 = runs first (higher number = hotter). 3 is
  // "normal" and is what an unset or legacy priority (0) reads as, so old jobs
  // and new default jobs sit together in the middle rather than at the bottom.
  const PRIO = j => { const n = parseInt(j && j.priority, 10); return (n >= 1 && n <= 5) ? n : 3; };
  const clampPrio = v => { const n = parseInt(v, 10); return (n >= 1 && n <= 5) ? n : 3; };
  // Is this machine deliberately out of service? Distinct from `online: false`,
  // which means the probe could not reach it — a fault, or a cable, or nothing
  // at all. Maintenance is a decision a human made, and the two must never be
  // rendered or reported as the same thing.
  const maintOf = idx => D.maintenance[String(idx)] || null;
  // ISO week key, local time (Thursday-anchored per ISO 8601).
  function isoWeekKey(ms) {
    const dt = new Date(ms); dt.setHours(0, 0, 0, 0);
    dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
    const jan4 = new Date(dt.getFullYear(), 0, 4);
    const wk = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    return dt.getFullYear() + "-W" + String(wk).padStart(2, "0");
  }
  function dayWindow(ms) {                        // the effective window for that calendar day
    const dt = new Date(ms);
    const ov = D.settings.weekOverrides[isoWeekKey(ms)];
    const day = DAY_KEYS[dt.getDay()];
    return (ov && ov[day]) || D.settings.week[day] || DAY(false, "00:00", "00:00");
  }
  // Write, then swap. The swap is what makes a half-written file impossible —
  // but it is ALSO what silently ate 17 hours of edits on 2026-08-31.
  //
  // Staging lives on an SMB share (X: -> \\192.168.12.81\share). Windows
  // rename-over-an-existing-file across SMB does not reliably replace the
  // destination, so renameSync threw every single time, the .tmp was left on
  // disk holding the real state, dispatch.json kept its 07:37 contents, and the
  // executor's `tick().catch(() => {})` swallowed the error on every 10 s pass.
  // Removals vanished from the UI, came back on reload, and nothing anywhere
  // said why. resources.json and spools.json were unaffected because they write
  // straight to the file with no rename.
  //
  // So: keep the atomic path where the filesystem supports it, fall back to a
  // direct write where it does not, and NEVER fail silently. A non-atomic write
  // risks a torn file if the process dies mid-write; losing every edit for a day
  // is worse, and certain.
  let SAVE_FALLBACK = false;                     // latched, so we warn once
  function save() {
    const data = JSON.stringify(D, null, 2);
    const tmp = FILE + ".tmp";
    if (!SAVE_FALLBACK) {
      try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, FILE);                // atomic on a local volume
        return;
      } catch (e) {
        SAVE_FALLBACK = true;
        ctx.hublog("warn", "dispatch: atomic save failed (" + e.code + " " + e.message +
          ") — this filesystem rejects rename-over-existing. Falling back to a " +
          "direct write for the rest of this run.");
      }
    }
    fs.writeFileSync(FILE, data);                // fallback: not atomic, but it lands
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
  const newId = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // Sticky placement, in TWO layers (fixed v2.12). A plan is something a human
  // reads and acts on, so it must not reshuffle every time anything happens -
  // but v2.11 kept that promise by writing every planner choice into the same
  // map the user's explicit "Move" wrote to. After one plan() run every job
  // behaved like a user pin, and the consequences were:
  //   * free a printer, hit Replan, and it stays idle forever - no queued job
  //     is allowed to migrate to it (Danny, field, 2026-08-30);
  //   * the pin is read per COPY but keyed per JOB, so copy 1 sets it and
  //     copies 2..n are forced onto that same lane. A qty-4 job serialises
  //     onto one machine while the rest of the farm sits idle.
  //   PINS      - HARD. Only /api/dispatch/jobs/assign writes here. The user
  //               said "this job goes on that machine"; the planner obeys and
  //               considers no other lane.
  //   PLACEMENT - SOFT. Where the last plan put each COPY, keyed per copy so
  //               copies never inherit each other's lane. Advisory: a copy
  //               stays put unless another machine finishes it
  //               STICKY_TOLERANCE_MIN earlier. Estimate jitter can't reshuffle
  //               the plan; freed capacity - worth hours, not minutes - can.
  const PINS = new Map();                        // job.id -> printer index (the user's choice)
  const PLACEMENT = new Map();                   // job.id + "#" + copy -> printer index
  const forget = jobId => {                      // drop every trace of one job's placement
    PINS.delete(jobId);
    for (const k of PLACEMENT.keys())
      if (k.slice(0, k.lastIndexOf("#")) === jobId) PLACEMENT.delete(k);
  };
  // A finished job LEAVES (v2.14, Danny's call). Before this, the last copy
  // flipped the job to state "done" and it sat in the list forever — 54 jobs
  // in the field, 19 of them finished, greyed out and permanently in the way.
  // Nothing read them: job.history is written and consumed by nobody, and
  // printlog.json already records "last printed" per file, so the queue was
  // paying rent on a record no screen ever showed.
  //
  // Removal is immediate and total: the job, its placement keys, and any
  // bundle it leaves empty.
  //
  // A bundle is a grouping, not a thing in its own right: with no members it
  // renders as nothing and only grows the file. Pruned wherever jobs leave —
  // finished OR deleted by hand, since either can empty one.
  function pruneBundles() {
    D.bundles = D.bundles.filter(b => D.jobs.some(j => j.bundle_id === b.id));
  }
  function finish(job, why) {
    forget(job.id);
    D.jobs = D.jobs.filter(x => x.id !== job.id);
    // Anything pushed back behind this job is now waiting on something that no
    // longer exists. The planner already ignores a dead target, but leaving the
    // pointer in the file means the UI keeps saying "waiting on <a job you
    // cannot see>" — so clear it and let those jobs fall back to their natural
    // place. Their turn has, after all, arrived.
    releaseWaitersOf(job.id);
    pruneBundles();
    ctx.hublog("info", "dispatch: '" + job.file + "' " + (why || "finished") +
      " — removed from the queue (" + job.qty + " cop" + (job.qty === 1 ? "y" : "ies") + " done)");
  }
  // v2.20: drop `after` pointers aimed at a job that has left the queue.
  function releaseWaitersOf(goneId) {
    let n = 0;
    for (const j of D.jobs) if (j.after === goneId) { delete j.after; n++; }
    if (n) ctx.hublog("info", "dispatch: " + n + " job" + (n === 1 ? "" : "s") +
      " released — the job they were pushed behind is gone");
    return n;
  }
  // Jobs that finished under the old rule are still in dispatch.json. Sweep
  // them once at load rather than making Danny clear 19 rows by hand.
  {
    const stale = D.jobs.filter(j => j.state === "done");
    if (stale.length) {
      D.jobs = D.jobs.filter(j => j.state !== "done");
      pruneBundles();
      save();
      // Deleting 19 rows out from under someone silently is not on. Name them.
      ctx.hublog("info", "dispatch: swept " + stale.length + " already-finished job" +
        (stale.length === 1 ? "" : "s") + " out of the queue (" +
        stale.slice(0, 6).map(j => j.file).join(", ") + (stale.length > 6 ? ", …" : "") + ")");
    }
  }
  const AWAITING = new Set();                    // printer idx flagged "bed needs clearing" (in-memory)
  const LAST_STATE = new Map();                  // printer idx -> last seen print state

  // ---- window math ----------------------------------------------------------
  const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const validHm = s => hm(s) !== null && hm(s) >= 0 && hm(s) < 1440;
  // A day is a LIST of windows: real days have gaps ("home 8-11, out, back
  // 5-10"). Legacy {start,end} days read as a single window. Function
  // declaration (not const) so ordering inside register() can't bite.
  function dayWindows(d) {
    if (!d || d.on === false) return [];
    const ws = Array.isArray(d.windows) && d.windows.length ? d.windows
             : (d.start && d.end ? [{ start: d.start, end: d.end }] : []);
    return ws.filter(w => w && validHm(w.start) && validHm(w.end) && hm(w.start) < hm(w.end))
             .sort((x, y) => hm(x.start) - hm(y.start));
  }
  function inAway(ms) {
    for (const a of D.settings.away || []) if (a && ms >= a.from && ms < a.to) return a.to;
    return null;
  }
  // Earliest allowed START at or after fromMs (attended window minus away).
  function nextStart(fromMs) {
    let t = fromMs;
    for (let guard = 0; guard < 14 * 4; guard++) {           // ≤ 14 days of walking
      const awayEnd = inAway(t); if (awayEnd) { t = awayEnd; continue; }
      const dt = new Date(t);
      const wins = dayWindows(dayWindow(t));
      const nextDay = () => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1, 0, 0).getTime();
      if (!wins.length) { t = nextDay(); continue; }          // day off / no windows
      const mod = dt.getHours() * 60 + dt.getMinutes();
      const inside = wins.find(w => mod >= hm(w.start) && mod < hm(w.end));
      if (inside) return t;                                   // already inside a window
      const later = wins.find(w => hm(w.start) > mod);         // a later window today
      if (later) { t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, hm(later.start)).getTime(); continue; }
      t = nextDay();
    }
    return null;                                             // no window in 2 weeks (deep away block)
  }
  // FINISH POLICY (v2.11, Danny's call). Attended hours gate when a job may
  // START \u2014 the moment your hands are needed. A print RUNNING unattended is
  // just printing; refusing to run past your hours would idle the farm all
  // day. So by default a job may finish whenever.
  //   settings.finish_policy:
  //     "anytime" (default) \u2014 start inside a window, finish whenever
  //     "attended"          \u2014 must also finish inside the same window
  //                           (for users who want to catch every removal)
  // Per job, needs_finish:true forces the strict rule for that job alone
  // (delicate removal, same-day shipping). Off by default.
  function fitEnd(startMs, estMin, strict) {
    const end = startMs + estMin * 60000;
    if (!strict) return end;
    const dt = new Date(startMs);
    const mod = dt.getHours() * 60 + dt.getMinutes();
    const w = dayWindows(dayWindow(startMs)).find(x => mod >= hm(x.start) && mod < hm(x.end));
    if (!w) return null;
    const closeMs = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, hm(w.end)).getTime();
    return end <= closeMs ? end : null;
  }
  // When can this printer realistically take its NEXT job? The bed must be
  // cleared by a human first, so a print that ends while you're out blocks the
  // machine until your next attended window. Modeling that honestly is the
  // point of the timeline \u2014 seeing "idle until 6pm tomorrow" is what makes
  // you reorder jobs to limit it.
  function readyAfter(endMs) {
    const clear = nextStart(endMs);                 // first attended moment at/after the end
    return (clear === null ? endMs : clear) + BED_CLEAR_BUFFER_MIN * 60000;
  }

  // Attended windows as absolute intervals, for the guide to shade closed
  // hours behind the blocks (v2.15). The CLIENT must not re-derive this: it
  // would be a second implementation of the week template, overrides and away
  // blocks, and the day it drifts the guide shows a job starting inside grey.
  // The server already knows; it just never said so out loud.
  function attendedSpans(fromMs, toMs) {
    let spans = [];
    const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    for (let t = midnight(new Date(fromMs)), guard = 0; t < toMs && guard < 40; guard++) {
      const dt = new Date(t);
      for (const w of dayWindows(dayWindow(t))) {
        const s = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, hm(w.start)).getTime();
        const e = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 0, hm(w.end)).getTime();
        if (e > fromMs && s < toMs) spans.push({ from: s, to: e });
      }
      t = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1).getTime();
    }
    // Away blocks cut holes in the windows they overlap — being on the calendar
    // is not the same as being in the building.
    for (const a of D.settings.away || []) {
      const next = [];
      for (const s of spans) {
        if (a.to <= s.from || a.from >= s.to) { next.push(s); continue; }
        if (a.from > s.from) next.push({ from: s.from, to: a.from });
        if (a.to < s.to) next.push({ from: a.to, to: s.to });
      }
      spans = next;
    }
    return spans.slice(0, 200);
  }

  // ---- swap cost off real state --------------------------------------------
  const norm = h => String(h || "").trim().replace(/^#/, "").slice(0, 6).toUpperCase();
  function loadedHexes(fp) {                    // fleet-snapshot printer record -> Set of tray hexes
    const out = new Set();
    for (const h of (fp && Array.isArray(fp.heads) ? fp.heads : []))
      if (h && h.hex) out.add(norm(h.hex));
    return out;
  }
  function shelfByHex() {                        // physical rolls by color (multi-color spools excluded)
    const by = {};
    const shelf = ctx.spoolShelf();
    for (const [sid, sp] of Object.entries(shelf || {})) {
      if (!sp || (Array.isArray(sp.hexes) && sp.hexes.length > 1)) continue;
      const h = norm(sp.hex); if (!h) continue;
      if (!by[h]) by[h] = { spool_id: sid, name: sp.color_name || ("#" + h), brand: sp.brand || null };
    }
    return by;
  }
  function swapsFor(jobColors, fp) {
    const loaded = loadedHexes(fp);
    const shelf = shelfByHex();
    const swaps = [];
    for (const c of jobColors || []) {
      const h = norm(c);
      if (!h || loaded.has(h)) continue;
      const roll = shelf[h] || null;
      swaps.push({ color: "#" + h, spool_id: roll && roll.spool_id, spool: roll && roll.name, brand: roll && roll.brand });
    }
    return swaps;
  }

  // ---- spool exclusivity ----------------------------------------------------
  // A roll of filament is a physical object: it cannot be in two printers at
  // once. The Hub assumes ONE roll per distinct colour unless a tray somewhere
  // is already showing it. Two jobs needing black therefore cannot overlap.
  //
  // 2026-09-01: it was proposed to soften this using the Resource Monitor's
  // on-hand figures — count the rolls, only warn when concurrent demand exceeds
  // them. Danny said no, and was right: the shelf is only partly entered. A
  // colour with two rolls recorded and eight on the wall would stop warning
  // correctly; a colour with two recorded and two on the wall would stop
  // warning by luck. Inferring capacity from an inventory nobody has finished
  // filling in turns a conservative warning into a confident wrong one, and it
  // fails silently — you find out when two machines want the same roll.
  //
  // So it stays at one. Revisit only if the shelf ever becomes authoritative,
  // and even then only for colours whose count is explicitly confirmed rather
  // than merely present.
  //
  // We do NOT silently serialise them: the second job is planned where it
  // naturally falls and the slot carries a `contention` note naming the colour
  // and the machine holding it, so a human can decide (buy another roll,
  // reorder, let it wait). Invisible constraints are how you end up staring at
  // a plan wondering why nothing starts.
  function colorNeedsOf(job, fp) {
    // Colours this job needs that aren't already loaded on that printer.
    const loaded = loadedHexes(fp);
    return (job.colors || []).map(norm).filter(h => h && !loaded.has(h));
  }
  // Which colours does a planned slot OCCUPY while it runs? Everything the job
  // prints with — loaded or freshly mounted — is tied up for the duration.
  function colorsHeld(job) { return (job.colors || []).map(norm).filter(Boolean); }
  function findContention(colors, startMs, endMs, placed) {
    for (const p of placed) {
      if (p.end <= startMs || p.start >= endMs) continue;      // no time overlap
      const clash = colors.find(c => p.colors.includes(c));
      if (clash) return { color: "#" + clash, printer: p.printerName, file: p.file,
                          until: p.end };
    }
    return null;
  }

  // v2.22: LOCKED-SCHEDULE RECONCILER. A frozen plan is a photograph, and the
  // farm keeps moving under it: copies finish, jobs get cancelled, new work is
  // queued. Serving the raw snapshot forever would show prints that already
  // came off the bed and hide everything added since. So reconcile it against
  // the live job list WITHOUT re-placing anything - the whole point of locked
  // is that the times you approved stop moving.
  //   - keep a frozen slot only if its job still exists and still has that copy
  //     to print (drop copies that finished or were cancelled, oldest first -
  //     the earliest-starting copies are the ones already run)
  //   - never invent a slot: a job that gained copies or is brand new since the
  //     lock has no place on the frozen board, so it is reported in
  //     new_since_lock instead of being silently scheduled behind the plan's back
  function reconcileFrozen(frozen, ordered) {
    const byJob = new Map();               // job_id -> frozen placed slots
    for (const s of (frozen.slots || [])) {
      if (s.unplannable) continue;         // unplannable was never a placement
      if (!byJob.has(s.job_id)) byJob.set(s.job_id, []);
      byJob.get(s.job_id).push(s);
    }
    for (const arr of byJob.values()) arr.sort((a, b) => (a.est_start || 0) - (b.est_start || 0));
    const slots = [];
    const newSinceLock = [];
    for (const job of ordered) {
      const inFlight = job.printing_on != null ? 1 : 0;
      const need = Math.max(0, (job.remaining ?? job.qty ?? 1) - inFlight);
      const frz = byJob.get(job.id) || [];
      const keep = need <= 0 ? [] : frz.slice(Math.max(0, frz.length - need)); // last `need`; earliest are finished
      for (const s of keep) slots.push({ ...s, locked: true });
      const short = need - keep.length;    // live copies the frozen board has no home for
      if (short > 0) newSinceLock.push({ job_id: job.id, file: job.file, count: short });
    }
    slots.sort((a, b) => (a.est_start || 0) - (b.est_start || 0)); // keep the frozen row order stable
    return { slots, newSinceLock };
  }

  // ---- the plan -------------------------------------------------------------
  async function plan() {
    const now = Date.now();
    const fleet = await ctx.fleet();
    const printers = (fleet || []).map((fp, i) => ({ fp, i }))
      .filter(x => x.fp && x.fp.online !== false);
    // Per-printer cursor: idle machines are available now; printing machines
    // when their current job's remaining time (if the probe reports one) runs
    // out; unknowable machines go to the back of the line, flagged.
    const lanes = printers.map(x => {
      let cursor = now, note = null;
      const st = String((x.fp.status || x.fp.state || "")).toLowerCase();
      if (/print/.test(st) || /pause/.test(st)) {   // paused still occupies the machine
        const rem = (typeof x.fp.etaSec === "number") ? x.fp.etaSec / 60
                  : [x.fp.remainingMin, x.fp.etaMin].find(v => typeof v === "number");
        if (typeof rem === "number") cursor = now + rem * 60000;
        else { cursor = now + 8 * 3600000; note = "busy, remaining time unknown — planned pessimistically"; }
      }
      // busyUntil / lastEnd / queued exist for the FEASIBILITY REPORT, not for
      // planning: they are what lets a miss say "queued behind 3 copies" or
      // "waiting on the print already running" instead of just "it's late".
      // A machine in maintenance STAYS in `lanes`. Dropping it here would hide
      // a print it is genuinely still running from the timeline and from the
      // running[] list — the Hub would go quiet about real work on the bed.
      // It is excluded at the placement step instead, so nothing NEW lands on
      // it while everything already true about it keeps being reported.
      return { idx: x.i, name: x.fp.name || ("printer " + (x.i + 1)),
               multiColor: !!(x.fp.caps && x.fp.caps.multiColor), fp: x.fp, cursor, note,
               paused: /pause/.test(st), maint: maintOf(x.i),
               busyUntil: cursor > now ? cursor : null, lastEnd: null, queued: 0 };
    });
    // Bundle deadlines tighten members'.
    const bundleDeadline = {};
    for (const b of D.bundles) if (b.deadline) bundleDeadline[b.id] = b.deadline;
    // The farm target is a FALLBACK, never an override. A job that carries its
    // own deadline — or inherits one from its bundle — is judged against that,
    // whether it is tighter than the target or looser. Only jobs with no
    // deadline of their own answer to the target. Overriding a deliberately
    // looser per-job deadline would report a miss the user never asked about,
    // and reporting a miss nobody cares about is how a warning stops being read.
    const TARGET = (Number.isFinite(+D.settings.target) && +D.settings.target > 0) ? +D.settings.target : null;
    const deadlineOf = j => {
      const bd = j.bundle_id ? bundleDeadline[j.bundle_id] : null;
      if (j.deadline && bd) return { at: Math.min(j.deadline, bd), src: j.deadline <= bd ? "job" : "bundle" };
      if (j.deadline) return { at: j.deadline, src: "job" };
      if (bd) return { at: bd, src: "bundle" };
      return TARGET ? { at: TARGET, src: "target" } : { at: null, src: null };
    };
    const effDeadline = j => deadlineOf(j).at;
    // v2.22: DEADLINES WIN, priority breaks ties (Danny's call). Earliest
    // deadline first, always — a job with a real due date is never bumped by a
    // higher priority number, because a missed deadline is a promise broken and
    // a priority is only a preference. Among jobs sharing an effective deadline
    // (all the no-deadline ones share Infinity; all the under-the-farm-target
    // ones share the target), the 1-5 priority orders them, 5 first. So a 5
    // jumps the line past 3s and 1s that are equally un-urgent, but never past
    // something about to be late. Created-time is the final, stable tiebreak.
    const runnable = D.jobs.filter(j => j.state === "queued" || j.state === "scheduled" || j.state === "printing");
    const ordered = [...runnable].sort((a, b) =>
      ((effDeadline(a) || Infinity) - (effDeadline(b) || Infinity)) ||
      (PRIO(b) - PRIO(a)) ||
      (a.created - b.created));
    // ---- "push it back" (v2.20) ---------------------------------------------
    // Three jobs all wanting the one green roll get planned to start together,
    // with a contention note on two of them — the Hub sees the clash and says
    // so, but has never let you do anything about it except move a job to
    // another machine. Sometimes the answer is neither: you want THIS one to
    // wait and the next one to run, because more green may arrive before it
    // matters.
    //
    // job.after holds the id of the job it was pushed behind. It is a nudge,
    // not a schedule: one press moves a job one place, and pressing again moves
    // it one more. Deliberately NOT a timestamp — a time you picked goes stale
    // the moment anything upstream shifts, whereas "after that one" stays true.
    //
    // Two passes are needed because a job can only be floored against a target
    // that has already been placed, so the target has to come first in the
    // list. Cycles and dead targets are dropped rather than trusted: `after`
    // survives in the file across restarts, and the job it names may have been
    // finished or deleted since.
    {
      const byId = new Map(ordered.map(j => [j.id, j]));
      const resolve = (j, seen) => {              // walk the chain, refuse loops
        const t = j.after && byId.get(j.after);
        if (!t || t === j) return null;
        if (seen.has(t.id)) return null;
        seen.add(t.id);
        return t;
      };
      for (let pass = 0; pass < ordered.length; pass++) {
        let moved = false;
        for (let i = 0; i < ordered.length; i++) {
          const j = ordered[i];
          const t = resolve(j, new Set([j.id]));
          if (!t) continue;
          const ti = ordered.indexOf(t);
          if (ti < i) continue;                   // already behind it
          ordered.splice(i, 1);
          ordered.splice(ordered.indexOf(t) + 1, 0, j);
          moved = true;
          break;
        }
        if (!moved) break;
      }
    }
    // When each job's last copy is expected to finish, filled in as we place.
    // A pushed-back job cannot start before its target has finished.
    const jobEnds = new Map();
    // Placement excludes machines in maintenance. Because plan() rebuilds from
    // scratch on every call, this is the whole of the redistribution: mark a
    // printer down and its share of the queue lands on the others on the very
    // next plan; bring it back and the queue spreads to include it again.
    // Nothing is moved or rewritten — the plan is simply recomputed against the
    // machines actually available. Pins self-heal too: honoring a pin requires
    // the pinned lane to be in `eligible`, so a pin to a machine that went down
    // falls back to the open pool and is restored when it comes back up.
    const usable = lanes.filter(l => !l.maint);
    const down = lanes.length - usable.length;
    const slots = [];
    // v2.22: LOCKED. Serve the frozen snapshot instead of re-placing anything.
    // Everything above (fleet, lanes, running, attended, the ordering) is still
    // computed live, because those are facts about the world; only the PLACED
    // slots are held still. reconcileFrozen drops copies that have since run or
    // been removed and reports anything added since the lock, so the board
    // stays honest without moving. Fall through to the optimizer when fluid.
    const locked = D.settings.schedule_mode === "locked" && D.frozen && Array.isArray(D.frozen.slots);
    let newSinceLock = [];
    if (locked) {
      const r = reconcileFrozen(D.frozen, ordered);
      for (const s of r.slots) slots.push(s);
      newSinceLock = r.newSinceLock;
    } else {
    const placed = [];      // [{start,end,colors,printerName,file}] for exclusivity checks
    const seen = new Set(); // placement keys this run still uses (everything else is stale)
    for (const job of ordered) {
      // A copy a machine is printing RIGHT NOW is already accounted for -
      // subtract it so the planner never schedules work the farm is doing.
      const inFlight = job.printing_on != null ? 1 : 0;
      const copies = Math.max(0, (job.remaining ?? job.qty ?? 1) - inFlight);
      const est = job.est_minutes || 60;         // unknown estimate: assume an hour, honestly labeled
      for (let c = 0; c < copies; c++) {
        if (slots.length >= PLAN_SLOT_CAP) break;
        const eligible = usable.filter(l => !job.multi || l.multiColor);
        if (!eligible.length) {
          // Name the real cause. "No eligible printer" when the truth is "you
          // took them all down yourself" sends someone hunting for a fault.
          const why = !usable.length
            ? (down ? "every printer is down for maintenance" : "no printer is online")
            : "no eligible printer (multi-color job, no multi-color machine available" +
              (down ? "; " + down + " down for maintenance" : "") + ")";
          slots.push({ job_id: job.id, file: job.file, unplannable: why });
          continue;
        }
        const key = job.id + "#" + c;              // per COPY, never per job
        seen.add(key);
        const pinned = PINS.get(job.id);           // hard: the user moved this job here
        const lastLane = PLACEMENT.get(key);       // soft: where this copy sat last plan
        const pool = (pinned !== undefined && eligible.some(l => l.idx === pinned))
                   ? eligible.filter(l => l.idx === pinned)   // honor the user's choice
                   : eligible;
        const cands = [];
        for (const l of pool) {
          const strict = !!job.needs_finish || D.settings.finish_policy === "attended";
          // Walk forward through attended blocks looking for one the job FITS
          // in. Under the default "anytime" policy a long print may legitimately
          // overrun its block (that's the whole point - prints run while you're
          // out), but overrunning should be a CONSEQUENCE of a job being longer
          // than any block, never a preference: don't start at 08:00 in a
          // one-hour window when a 62-minute job fits cleanly at 17:00.
          // A pushed-back job waits for the job it was put behind to FINISH.
          // Flooring at that job's start instead would let the two overlap on
          // different machines, which is exactly the situation being escaped.
          const floor = jobEnds.get(job.after) || 0;
          let start = nextStart(Math.max(l.cursor, now, floor));
          let realEnd = null, firstStart = start, firstEnd = null;
          for (let hop = 0; hop < 30 && start !== null; hop++) {
            const fits = fitEnd(start, est, true);          // does it fit this block?
            if (firstEnd === null) { firstStart = start; firstEnd = start + est * 60000; }
            if (fits !== null) { realEnd = fits; break; }
            const d0 = new Date(start);
            const wins = dayWindows(dayWindow(start));
            const mod = d0.getHours() * 60 + d0.getMinutes();
            const later = wins.find(w => hm(w.start) > mod);
            start = later
              ? nextStart(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate(), 0, hm(later.start)).getTime())
              : nextStart(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1, 0, 0).getTime());
          }
          if (realEnd === null && !strict) {
            // Nothing it fits inside within two weeks - it's simply a long
            // print. Start it at the earliest attended moment and let it run.
            start = firstStart; realEnd = firstEnd;
          }
          const realStart = start;
          if (realStart === null || realEnd === null) continue;
          const swaps = swapsFor(job.colors, l.fp);
          // SCORING (fixed v2.11): finish time first, swaps as a weighted
          // tiebreak. Scoring swaps FIRST packed jobs onto already-used lanes
          // (a used lane inherits the last job's colors, so it scores zero
          // swaps) and left idle printers empty for hours \u2014 exactly the
          // capacity waste the scheduler exists to prevent. A swap is worth
          // avoiding when start times are comparable, not when it costs half a
          // day of an idle machine.
          const cost = realEnd + swaps.length * SWAP_COST_MIN * 60000;
          cands.push({ lane: l, start: realStart, end: realEnd, swaps, cost });
        }
        let best = null;
        for (const cand of cands) if (!best || cand.cost < best.cost) best = cand;
        // Stability without stickiness. Keep this copy on the machine it had
        // last time UNLESS moving it is a real win - a freed printer shows up
        // as hours earlier, estimate noise as minutes. Without the tolerance
        // the plan churns on every refresh; with a hard pin it can never move.
        if (best && lastLane !== undefined && best.lane.idx !== lastLane) {
          const stay = cands.find(x => x.lane.idx === lastLane);
          if (stay && stay.cost - best.cost <= STICKY_TOLERANCE_MIN * 60000) best = stay;
        }
        if (!best) { slots.push({ job_id: job.id, file: job.file, unplannable: "no attended window found within 14 days" }); continue; }
        const dlInfo = deadlineOf(job);
        const dl = dlInfo.at;
        // WHY this copy lands when it lands. Everything between now and its
        // start is one of four waits, and naming the biggest one is the whole
        // difference between "3 jobs miss your deadline" (useless) and "3 jobs
        // miss it because nobody clears P2's bed until 08:05" (actionable).
        //   inflight — the machine is running a print right now
        //   queue    — earlier copies in THIS plan hold the machine
        //   bed      — a print ended but the bed can't be cleared until you're back
        //   window   — the machine is free and you are not: outside attended hours
        const cur = best.lane.cursor;                       // pre-placement (advanced below)
        const unavail = Math.max(0, Math.min(cur, best.start) - now);
        const wQueue = best.lane.lastEnd != null ? Math.max(0, Math.min(best.lane.lastEnd, best.start) - now) : 0;
        const wFlight = best.lane.lastEnd == null ? unavail : 0;
        const wBed = Math.max(0, unavail - wQueue - wFlight);
        const wWindow = Math.max(0, best.start - Math.max(now, cur));
        const mins = ms => Math.round(ms / 60000);
        const held = colorsHeld(job);
        // Latest end across this job's copies — what a job pushed behind it
        // has to wait for.
        jobEnds.set(job.id, Math.max(jobEnds.get(job.id) || 0, best.end));
        const clash = findContention(held, best.start, best.end, placed);
        placed.push({ start: best.start, end: best.end, colors: held,
                      printerName: best.lane.name, file: job.file });
        slots.push({
          job_id: job.id, file: job.file, type: job.type, copy: c + 1, of: copies,
          printer: best.lane.idx, printerName: best.lane.name,
          est_start: best.start, est_end: best.end, est_minutes: est,
          est_assumed: !job.est_minutes || undefined,
          swaps: best.swaps, deadline: dl, deadline_source: dlInfo.src || undefined,
          pinned: pinned !== undefined || undefined,
          // Pushed back behind another job, and behind which one — so the
          // timeline can say "waiting on X" rather than leaving a gap the user
          // has to explain to themselves.
          after: job.after || undefined,
          after_file: job.after ? ((D.jobs.find(x => x.id === job.after) || {}).file || undefined) : undefined,
          // minutes of each wait, plus what was ahead of it and until when
          delay: { inflight: mins(wFlight), queue: mins(wQueue), bed: mins(wBed), window: mins(wWindow) },
          queued_ahead: best.lane.queued || undefined,
          lane_free_at: cur > now ? cur : undefined,
          // A physical roll can't be in two machines at once. Flagged, not
          // silently rescheduled - the human decides what to do about it.
          contention: clash ? { color: clash.color, printer: clash.printer,
                                file: clash.file, until: clash.until } : undefined,
          // how long this machine then waits for a human to clear the bed
          idle_after_min: Math.max(0, Math.round((readyAfter(best.end) - best.end - BED_CLEAR_BUFFER_MIN * 60000) / 60000)) || undefined,
          misses_deadline: !!(dl && best.end > dl),
          lane_note: best.lane.note || undefined
        });
        PLACEMENT.set(key, best.lane.idx);       // soft only - never a pin
        const ready = readyAfter(best.end);
        best.lane.lastEnd = best.end;            // report bookkeeping (see delay above)
        best.lane.queued = (best.lane.queued || 0) + 1;
        best.lane.cursor = ready;
        best.lane.fp = { ...best.lane.fp };      // after a planned run the trays hold the job's colors
        best.lane.fp.heads = (job.colors || []).map(h => ({ hex: norm(h) }));
      }
    }
    // Copies that no longer exist (qty reduced, job finished or removed) must
    // not keep a lane reserved in the map - it would grow without bound and
    // resurrect a stale placement if the qty went back up.
    for (const k of PLACEMENT.keys()) if (!seen.has(k)) PLACEMENT.delete(k);
    } // end fluid placement (locked branch served the frozen snapshot above)
    // Report the whole fleet, not just the machines that got work: an idle
    // printer vanishing from the timeline hides exactly the capacity problem
    // the scheduler exists to surface.
    // WHAT IS ON THE BEDS RIGHT NOW (v2.15, Danny). `slots` is planned work,
    // and it deliberately excludes the copy a machine is already printing —
    // scheduling work the farm is doing is the bug that exclusion prevents. But
    // leaving the running print off the picture entirely meant a busy printer
    // drew as an unexplained empty lane until its ETA: the guide showed a hole
    // where the most certain thing on the farm belongs.
    //
    // So it is reported SEPARATELY, never merged into `slots`. It is a fact,
    // not a plan: nothing schedules it, the deadline report must not judge it,
    // and it cannot be moved. The block runs from now to the ETA rather than
    // from its true start, because the Hub knows the remaining time and not the
    // start — drawing a start it does not know would be a guess wearing the
    // costume of a measurement.
    const running = [];
    for (const l of lanes) {
      if (!l.busyUntil) continue;
      const fname = String(l.fp.filename || l.fp.file || "").split("/").pop();
      const held = D.jobs.find(j => j.printing_on === l.idx && j.state === "printing");
      running.push({
        printer: l.idx, printerName: l.name,
        file: fname || (held && held.file) || null,
        job_id: held ? held.id : null,
        tracked: !!held,                 // false = running, but Dispatch doesn't own it
        est_end: l.cursor,
        eta_unknown: !!l.note || undefined,
        paused: l.paused || undefined,
        // A print still running on a machine that is on its way down. The UI
        // says "finishing, then down" rather than pretending either half.
        maintenance: l.maint ? { since: l.maint.since, note: l.maint.note || "" } : undefined
      });
    }
    // The guide draws a real clock, so it needs the span the plan occupies and
    // the hours inside it you are actually around for.
    const ends = slots.filter(s => !s.unplannable).map(s => s.est_end);
    const spanTo = (ends.length ? Math.max(...ends) : now) + 3600000;
    return { generated_at: now, slots, running, target: TARGET,
             report: feasibility(slots, TARGET, now),
             attended: attendedSpans(now, spanTo),
             // v2.22: is the board frozen, and if so what arrived after the
             // freeze (queued but not on the locked plan, so the user knows
             // there is work the frozen picture is not showing).
             schedule_mode: D.settings.schedule_mode,
             locked, locked_at: locked && D.frozen ? D.frozen.locked_at : undefined,
             new_since_lock: newSinceLock,
             printers: lanes.map(l => ({ idx: l.idx, name: l.name, busy: !!l.note || l.cursor > now,
               maintenance: l.maint ? { since: l.maint.since, note: l.maint.note || "" } : null })) };
  }

  // ---- claim reconciliation (v2.14) -----------------------------------------
  // A job marked "printing on P2" that P2 knows nothing about is worse than
  // useless: one printer holds one job, so the claim can never be re-adopted,
  // and the planner treats P2 as busy — a machine quietly removed from the farm
  // (10 of them in the field, 2026-08-30). This releases such claims.
  //
  // The safety rule is the whole design: **release only against a printer that
  // actually answered.** Offline, unreachable, or blank-status machines prove
  // nothing, and freeing a real print because its printer was briefly
  // unreachable would have the planner schedule a duplicate of work already on
  // the bed. Silence is not evidence.
  //
  // Deliberately NOT wired into the 10 s background tick. A release that can
  // fire between any two lines makes every test that touches a claim race a
  // timer, which is the exact failure MISTAKES.md keeps logging. It runs once
  // at boot and whenever a human taps "claim running prints" — which is the
  // honest reading of that button anyway: match the queue to reality, in both
  // directions.
  function reconcile(fleet) {
    const released = [];
    for (const job of [...D.jobs]) {
      if (job.state !== "printing" || job.printing_on == null) continue;
      const fp = (fleet || [])[job.printing_on];
      if (!fp || fp.online === false) continue;              // never heard back — leave it alone
      const st = String(fp.status || fp.state || "").toLowerCase();
      if (!st) continue;                                     // answered, but said nothing usable
      const fname = String(fp.filename || fp.file || "").split("/").pop();
      if ((/print/.test(st) || /pause/.test(st)) && fname === job.file) continue;   // the claim is true
      const label = fp.name || ("printer " + (job.printing_on + 1));
      released.push({ printer: label, file: job.file,
                      printer_state: st, printer_file: fname || null });
      job.printing_on = null;
      if (job.remaining > 0) { job.state = "queued"; forget(job.id); }
      else finish(job, "claim was stale and nothing was left to print");
      ctx.hublog("info", "dispatch: released stale claim — '" + job.file + "' said it was on " +
        label + ", which reports '" + st + "'" + (fname ? " running '" + fname + "'" : ""));
    }
    if (released.length) save();
    return released;
  }
  // One shot at boot, once the fleet has had a moment to answer. Anything
  // still claiming a machine that contradicts it was left over from a Hub that
  // died mid-print, and nothing else will ever clear it.
  const bootSweep = setTimeout(() => {
    ctx.fleet().then(f => reconcile(f)).catch(() => {});
  }, 3000);
  if (bootSweep.unref) bootSweep.unref();

  // ---- executor: completion watcher (never a starter) -----------------------
  async function tick() {
    let fleet; try { fleet = await ctx.fleet(); } catch { return; }
    let dirty = false;
    for (let i = 0; i < (fleet || []).length; i++) {
      const fp = fleet[i]; if (!fp) continue;
      const st = String(fp.status || fp.state || "").toLowerCase();
      const prev = LAST_STATE.get(i);
      LAST_STATE.set(i, st);
      if (prev === undefined) continue;
      const fname = String(fp.filename || fp.file || "").split("/").pop();
      // A transition INTO complete is a completion — whatever the previous
      // state looked like. A print shorter than one tick, or a Hub restarted
      // mid-print, shows up as standby/unknown → complete; the file match
      // against an active dispatch job is the real gate. Steady-state
      // "complete" never re-fires (prev === st).
      if (!/complete/.test(prev) && /complete/.test(st)) {
        AWAITING.add(i);
        const job = D.jobs.find(j => (j.state === "printing" || j.state === "scheduled" || j.state === "queued") &&
                                     j.file === fname && (j.printing_on === i || j.printing_on == null));
        if (job) {
          job.remaining = Math.max(0, (job.remaining ?? job.qty) - 1);
          (job.history = job.history || []).push({ printer: i, ended: Date.now(), result: "complete" });
          job.printing_on = null;
          dirty = true;
          ctx.hublog("info", "dispatch: '" + job.file + "' copy done on printer " + (i + 1) +
            " — " + job.remaining + " remaining; bed-clear gate armed");
          // Last copy: the job leaves. The bed-clear gate above is armed
          // independently of the job record, so removing it here does not cost
          // the "Bed cleared → start next" tap on that machine.
          if (job.remaining > 0) job.state = "queued";
          else finish(job, "finished its last copy");
        }
      }
      // Claim a print in progress. Two rules, both field-found 2026-08-28:
      //  * any transition INTO printing counts, AND a machine already printing
      //    when Dispatch/the Hub started gets adopted - otherwise the planner
      //    schedules copies of work the farm is doing right now;
      //  * one printer runs ONE print, so never attach a second job to a
      //    machine that already holds one (two entries for the same file,
      //    added on different days, both landed on printer 0 in the field).
      const heldHere = D.jobs.some(j => j.printing_on === i && j.state === "printing");
      // v2.19: the background tick must respect maintenance too. Guarding only
      // the /adopt endpoint would be theatre — this runs every 10 s and would
      // quietly re-attach a queue job to a machine the user has taken out of
      // service, putting the job back on a bed the planner is routing around.
      if ((/print/.test(st) || /pause/.test(st)) && fname && !heldHere && !maintOf(i)) {
        const job = D.jobs.find(j => j.state !== "done" && j.state !== "paused" &&
                                     j.file === fname && j.printing_on == null);
        if (job) {
          const adopting = !(prev && !/print/.test(prev));
          // No pin here: job.printing_on already excludes the in-flight copy
          // from planning, and swap-cost scoring already prefers the machine
          // that has the filament loaded. Pinning made the job's REMAINING
          // copies immovable too.
          job.state = "printing"; job.printing_on = i; dirty = true;
          if (adopting) ctx.hublog("info", "dispatch: adopted in-progress '" + job.file +
            "' on printer " + (i + 1) + " (it was already running)");
        }
      }
    }
    if (dirty) save();
  }
  // The executor must not die on a bad tick, but "must not die" is not "must
  // not tell anyone": this empty catch is what hid the save failure above for a
  // full day, firing every 10 s with nobody the wiser. Log it, rate-limited so a
  // persistent fault does not flood the ring buffer.
  let LAST_TICK_ERR = 0;
  const timer = setInterval(() => {
    tick().catch(e => {
      const now = Date.now();
      if (now - LAST_TICK_ERR > 60000) {
        LAST_TICK_ERR = now;
        ctx.hublog("error", "dispatch: executor tick failed — " + (e && e.message || e));
      }
    });
  }, EXEC_TICK_MS);
  if (timer.unref) timer.unref();
  // Manual tick: "recheck the fleet now". Makes completions show up instantly
  // after you clear a bed by hand, and makes the harness deterministic instead
  // of racing the 10 s interval.
  ctx.app.post("/api/dispatch/tick", async (req, res) => {
    try { await tick(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: "tick failed: " + e.message }); }
  });

  // ---- API ------------------------------------------------------------------
  const app = ctx.app;
  app.get("/api/dispatch", (req, res) => {
    res.json({ jobs: D.jobs, bundles: D.bundles, settings: D.settings,
               maintenance: D.maintenance,
               awaiting: [...AWAITING], auto_start_available: false });
  });

  // ---- push a job back one place (v2.20) -------------------------------------
  // POST /api/dispatch/jobs/push-back { id }        move it behind the next job
  // POST /api/dispatch/jobs/push-back { id, clear } put it back where it was
  //
  // The case this exists for: three jobs all needing the one green roll get
  // planned to start together. The Hub already flags the contention; this is
  // how you answer it without moving anything to another machine. Press it and
  // this job goes behind the next one in the plan; press it again and it goes
  // behind the one after that. More green may turn up before it matters, and if
  // it does not, press it again.
  //
  // "Behind the next job" is resolved against the CURRENT plan, not a stored
  // position, so it means what it looks like on screen at the moment you press
  // it — and the relationship stored is "after job X", which stays true when
  // everything upstream shifts. A timestamp would not.
  app.post("/api/dispatch/jobs/push-back", async (req, res) => {
    const b = req.body || {};
    const id = String(b.id || "");
    const job = D.jobs.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: "Unknown job" });

    if (b.clear) {
      delete job.after;
      save();
      let p = null; try { p = await plan(); } catch {}
      return res.json({ ok: true, job, plan: p });
    }

    let p;
    try { p = await plan(); }
    catch (e) { return res.status(500).json({ error: "Could not read the plan: " + e.message }); }

    // Job order as the plan actually plays out: first planned copy of each job,
    // earliest first. That is the order a person is looking at when they decide
    // something should go later.
    const firstOf = new Map();
    for (const s of (p.slots || [])) {
      if (s.unplannable) continue;
      if (!firstOf.has(s.job_id) || s.est_start < firstOf.get(s.job_id)) firstOf.set(s.job_id, s.est_start);
    }
    const seq = [...firstOf.entries()].sort((a, b2) => a[1] - b2[1]).map(([jid]) => jid);
    const i = seq.indexOf(id);
    if (i === -1) return res.status(409).json({
      error: "That job has no place in the current plan, so there is nothing to push it behind"
    });
    const nextId = seq[i + 1];
    if (!nextId) return res.status(409).json({
      error: "That job is already last in the plan — there is nothing after it to go behind"
    });

    job.after = nextId;
    save();
    const target = D.jobs.find(j => j.id === nextId);
    ctx.hublog("info", "dispatch: '" + job.file + "' pushed back behind '" + ((target && target.file) || nextId) + "'");
    let after = null;
    try { after = await plan(); } catch (e) { after = { error: "Pushed back, but replanning failed: " + e.message }; }
    res.json({ ok: true, job, behind: { id: nextId, file: target && target.file }, plan: after });
  });

  // ---- maintenance (v2.19) ---------------------------------------------------
  // "U5 is down while I rebuild the extruder." Until now the only way to say
  // that was to unplug the machine, which the Hub reads as `online: false` —
  // indistinguishable from a fault, a dead switch port, or a printer someone
  // carried off. Those are different facts and deserve different words.
  //
  // Marking a machine down does not touch a print already on its bed and does
  // not move a single job by hand: plan() simply stops placing new work there,
  // and because it replans from scratch every call, the queue redistributes
  // across the remaining machines immediately — and redistributes back the
  // moment the machine returns.
  app.post("/api/dispatch/maintenance", async (req, res) => {
    const b = req.body || {};
    const idx = parseInt(b.printer, 10);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: "Body needs { printer } as a printer index" });
    const fleet = (await ctx.fleet()) || [];
    if (idx >= fleet.length) return res.status(404).json({ error: "No printer at index " + idx });
    const down = b.down !== false;                      // default: take it down
    const key = String(idx);
    if (down) {
      const note = String(b.note || "").slice(0, 200);
      // Re-marking an already-down machine updates the note without resetting
      // "since" — how long it has been down is the useful number.
      D.maintenance[key] = { since: (D.maintenance[key] && D.maintenance[key].since) || Date.now(), note };
    } else {
      delete D.maintenance[key];
    }
    // Forget where copies sat last plan. STICKY_TOLERANCE_MIN normally keeps a
    // copy on the machine it had before unless another finishes it 30 min
    // sooner — that stability is right for ordinary replans, where moving bars
    // around for no reason is just noise.
    //
    // A machine going down or coming back is not noise. Without this the copies
    // pushed off a printer stayed put when it returned, and the machine sat
    // idle next to a queue it was perfectly able to help with — a farm running
    // at 1/9 capacity after a repair, which is the opposite of the point.
    // Pins are NOT cleared: those are decisions a human made about a particular
    // job, and they self-heal anyway (a pin to a down machine falls back to the
    // open pool and is honoured again on its return).
    PLACEMENT.clear();
    save();
    ctx.hublog("info", "dispatch: printer " + idx + " (" + ((fleet[idx] && fleet[idx].name) || idx) + ") " +
      (down ? "marked DOWN for maintenance" : "returned to service") + " — placements reset for a clean redistribution");
    // Hand back the replanned board, so the caller can see the redistribution
    // its own click caused rather than having to ask again for it.
    let replan = null;
    try { replan = await plan(); } catch (e) { replan = { error: "Marked, but replanning failed: " + e.message }; }
    res.json({ ok: true, maintenance: D.maintenance, plan: replan });
  });
  app.post("/api/dispatch/jobs", (req, res) => {
    const b = req.body || {};
    const file = String(b.file || "").trim();
    if (!file) return res.status(400).json({ error: "Job needs a file" });
    const info = ctx.fileInfo(file, b.type);
    if (!info.exists) return res.status(404).json({ error: "'" + file + "' not found in that type's folder" });
    const qty = Math.max(1, Math.min(999, parseInt(b.qty, 10) || 1));
    if (b.bundle_id && !D.bundles.find(x => x.id === b.bundle_id))
      return res.status(404).json({ error: "Unknown bundle" });
    const job = {
      id: newId("job"), file, type: String(b.type || "u1"),
      qty, remaining: qty,
      deadline: Number.isFinite(+b.deadline) ? +b.deadline : null,
      priority: clampPrio(b.priority),   // v2.22: 1-5, defaults to 3 (normal)
      bundle_id: b.bundle_id || null,
      needs_finish: !!b.needs_finish,   // "I want to be here when it lands"
      est_minutes: info.estMinutes, colors: info.colors, multi: info.multi,
      state: "queued", created: Date.now(), history: [], printing_on: null
    };
    D.jobs.push(job); save();
    res.json({ ok: true, job });
  });
  app.post("/api/dispatch/jobs/update", (req, res) => {
    const b = req.body || {};
    const j = D.jobs.find(x => x.id === b.id);
    if (!j) return res.status(404).json({ error: "Unknown job" });
    if (b.qty !== undefined) {
      const q = Math.max(1, Math.min(999, parseInt(b.qty, 10) || j.qty));
      j.remaining = Math.max(0, j.remaining + (q - j.qty)); j.qty = q;
      if (j.state === "done" && j.remaining > 0) j.state = "queued";
    }
    if (b.deadline !== undefined) j.deadline = Number.isFinite(+b.deadline) ? +b.deadline : null;
    if (b.priority !== undefined) j.priority = clampPrio(b.priority);   // v2.22: 1-5
    if (b.needs_finish !== undefined) j.needs_finish = !!b.needs_finish;
    if (b.state === "paused" || b.state === "queued") { if (j.state !== "printing") j.state = b.state; }
    save(); res.json({ ok: true, job: j });
  });
  app.post("/api/dispatch/jobs/remove", (req, res) => {
    forget((req.body || {}).id);
    const n = D.jobs.length;
    D.jobs = D.jobs.filter(x => x.id !== (req.body || {}).id);
    if (D.jobs.length === n) return res.status(404).json({ error: "Unknown job" });
    releaseWaitersOf((req.body || {}).id);   // v2.20: nothing waits on a deleted job
    pruneBundles();               // deleting the last member empties the bundle too
    save(); res.json({ ok: true });
  });
  app.post("/api/dispatch/bundles", (req, res) => {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "Bundle needs a name" });
    const rec = { id: newId("bdl"), name, deadline: Number.isFinite(+b.deadline) ? +b.deadline : null };
    D.bundles.push(rec); save(); res.json({ ok: true, bundle: rec });
  });
  app.post("/api/dispatch/bundles/remove", (req, res) => {
    const id = (req.body || {}).id;
    const n = D.bundles.length;
    D.bundles = D.bundles.filter(x => x.id !== id);
    if (D.bundles.length === n) return res.status(404).json({ error: "Unknown bundle" });
    for (const j of D.jobs) if (j.bundle_id === id) j.bundle_id = null;
    save(); res.json({ ok: true });
  });
  app.post("/api/dispatch/settings", (req, res) => {
    const b = req.body || {};
    if (b.auto_start === true)
      return res.status(400).json({ error: "Unattended auto-start ships only after its own hardware gate (Rule #1) \u2014 for now a human taps 'Bed cleared \u2192 start next'." });
    // Farm target, validated BEFORE anything is mutated: a 400 halfway down
    // this handler would leave the week edited in memory but unsaved, so the
    // running Hub and dispatch.json would disagree until the next write.
    // `null` or "" clears it — an explicit clear has to exist, or a target set
    // for one show haunts every plan after it. A target in the PAST is refused
    // rather than quietly accepted: it would mark literally everything missed,
    // and a warning that is always on is a warning nobody reads.
    let newTarget;                               // undefined = "not mentioned"
    if ("target" in b) {
      if (b.target === null || b.target === "") newTarget = null;
      else if (Number.isFinite(+b.target) && +b.target > Date.now()) newTarget = +b.target;
      else return res.status(400).json({ error: "A completion target has to be a moment in the future." });
    }
    const cleanDay = (d, cur) => {
      if (!d || typeof d !== "object") return cur;
      const on = d.on !== false;
      let ws = Array.isArray(d.windows) ? d.windows
             : (d.start || d.end) ? [{ start: d.start, end: d.end }] : null;
      if (!ws) return { ...cur, on };
      ws = ws.filter(w => w && validHm(w.start) && validHm(w.end) && hm(w.start) < hm(w.end))
             .map(w => ({ start: w.start, end: w.end }))
             .sort((x, y) => hm(x.start) - hm(y.start))
             .slice(0, 6);
      const merged = [];                                      // merge overlaps
      for (const w of ws) {
        const last = merged[merged.length - 1];
        if (last && hm(w.start) <= hm(last.end)) { if (hm(w.end) > hm(last.end)) last.end = w.end; }
        else merged.push({ ...w });
      }
      if (!merged.length) return { ...cur, on };
      return { on, windows: merged };
    };
    // Week TEMPLATE ("set these hours for every week")
    if (b.week && typeof b.week === "object")
      for (const k of DAY_KEYS) if (b.week[k]) D.settings.week[k] = cleanDay(b.week[k], D.settings.week[k]);
    // Per-calendar-week override ("just this week") \u2014 partial days allowed
    if (b.weekOverride && /^\d{4}-W\d{2}$/.test(String(b.weekOverride.key || ""))) {
      const key = b.weekOverride.key;
      const cur = D.settings.weekOverrides[key] || {};
      for (const k of DAY_KEYS) if (b.weekOverride.days && b.weekOverride.days[k])
        cur[k] = cleanDay(b.weekOverride.days[k], D.settings.week[k]);
      D.settings.weekOverrides[key] = cur;
      const keys = Object.keys(D.settings.weekOverrides).sort();
      while (keys.length > 26) delete D.settings.weekOverrides[keys.shift()];
    }
    if (typeof b.clearOverride === "string") delete D.settings.weekOverrides[b.clearOverride];
    if (b.finish_policy === "anytime" || b.finish_policy === "attended") D.settings.finish_policy = b.finish_policy;
    if (newTarget !== undefined) D.settings.target = newTarget;
    // Legacy pair still accepted \u2014 maps onto the template (Mon\u2013Fri / Sat+Sun)
    const win = (w, cur) => {
      if (!w) return null;
      const s = validHm(w.start) ? w.start : cur.start;
      const e = validHm(w.end) ? w.end : cur.end;
      return hm(s) < hm(e) ? { start: s, end: e } : null;
    };
    const at = win(b.attended, D.settings.attended);
    if (at) { D.settings.attended = at; for (const k of ["mon","tue","wed","thu","fri"]) D.settings.week[k] = { on: true, windows: [{ start: at.start, end: at.end }] }; }
    const wk = win(b.weekend, D.settings.weekend);
    if (wk) { D.settings.weekend = wk; for (const k of ["sat","sun"]) D.settings.week[k] = { on: true, windows: [{ start: wk.start, end: wk.end }] }; }
    if (Array.isArray(b.away))
      D.settings.away = b.away.filter(a => a && Number.isFinite(+a.from) && Number.isFinite(+a.to) && +a.to > +a.from)
                              .map(a => ({ from: +a.from, to: +a.to })).slice(0, 50);
    D.settings.auto_start = false;
    save(); res.json({ ok: true, settings: D.settings });
  });
  // Multi-plate prints: several gcode files that are ONE thing to deliver
  // ("Squirtle Body + Head"). Creates the bundle and one job per file
  // atomically \u2014 members share the bundle deadline, qty, and flags; the
  // scheduler already tightens members to the bundle deadline.
  app.post("/api/dispatch/bundle-jobs", (req, res) => {
    const b = req.body || {};
    const files = Array.isArray(b.files) ? b.files.map(f => String(f).trim()).filter(Boolean) : [];
    if (files.length < 2) return res.status(400).json({ error: "A multi-file job needs at least two files \u2014 use the normal add for one." });
    if (files.length > 24) return res.status(400).json({ error: "Too many files in one bundle (max 24)." });
    const infos = files.map(f => ({ f, info: ctx.fileInfo(f, b.type) }));
    const missing = infos.filter(x => !x.info.exists);
    if (missing.length) return res.status(404).json({ error: "Not found: " + missing.map(x => x.f).join(", ") });
    const qty = Math.max(1, Math.min(999, parseInt(b.qty, 10) || 1));
    const bundle = { id: newId("bdl"),
      name: String(b.name || "").trim() || (files[0].replace(/\.gcode$/i, "") + " +" + (files.length - 1)),
      deadline: Number.isFinite(+b.deadline) ? +b.deadline : null };
    D.bundles.push(bundle);
    const jobs = infos.map(({ f, info }) => {
      const job = { id: newId("job"), file: f, type: String(b.type || "u1"), qty, remaining: qty,
        deadline: null, priority: clampPrio(b.priority), bundle_id: bundle.id,
        needs_finish: !!b.needs_finish, est_minutes: info.estMinutes, colors: info.colors,
        multi: info.multi, state: "queued", created: Date.now(), history: [], printing_on: null };
      D.jobs.push(job); return job;
    });
    save(); res.json({ ok: true, bundle, jobs });
  });
  // Manual override: put this job on that printer (or clear the pin so the
  // scheduler is free to choose again).
  // Release a stale claim. A job can end up attached to the wrong machine for
  // reasons outside the Hub's control - two printers sharing an IP (field,
  // 2026-08-28), a printer re-addressed, a swap - and once attached it can't be
  // re-adopted, because one printer holds one job. This detaches it so the
  // executor (or the adopt button) can claim it against reality.
  app.post("/api/dispatch/jobs/release", (req, res) => {
    const j = D.jobs.find(x => x.id === (req.body || {}).id);
    if (!j) return res.status(404).json({ error: "Unknown job" });
    const was = j.printing_on;
    j.printing_on = null;
    // Releasing the claim on a job with nothing left to print doesn't leave a
    // "done" row behind any more — there is no such row now.
    if (j.remaining > 0) { if (j.state === "printing") j.state = "queued"; forget(j.id); }
    else finish(j, "released with no copies left");
    save();
    ctx.hublog("info", "dispatch: released '" + j.file + "' from printer " +
      (was == null ? "(none)" : was + 1) + " - free to be re-claimed");
    res.json({ ok: true, released_from: was, job: j });
  });
  app.post("/api/dispatch/jobs/assign", (req, res) => {
    const b = req.body || {};
    const j = D.jobs.find(x => x.id === b.id);
    if (!j) return res.status(404).json({ error: "Unknown job" });
    // "auto" is a request for a fresh decision, so drop the soft placement too
    // — otherwise the copy sits where the last plan put it.
    if (b.printer === null || b.printer === "auto") { forget(j.id); return res.json({ ok: true, pinned: null }); }
    const idx = parseInt(b.printer, 10);
    const fleetSize = (ctx.printers || []).length;
    if (!Number.isInteger(idx) || idx < 0 || (fleetSize && idx >= fleetSize))
      return res.status(400).json({ error: "No such printer" });
    PINS.set(j.id, idx);
    res.json({ ok: true, pinned: idx });
  });
  // "The farm is already busy - claim what's running." Probes every printer and
  // matches live prints to queued jobs, so Dispatch stops scheduling copies of
  // prints already in progress. Reports what it adopted (and what's running
  // that it couldn't match) rather than silently mutating the plan.
  app.post("/api/dispatch/adopt", async (req, res) => {
    let fleet;
    try { fleet = await ctx.fleet(); }
    catch (e) { return res.status(502).json({ error: "Could not read the fleet: " + e.message }); }
    // Matching the queue to reality runs BOTH ways, and letting go comes
    // first: a job wrongly holding printer 2 blocks the real print on printer 2
    // from being claimed at all, because one printer holds one job.
    const released = reconcile(fleet);
    const adopted = [], already = [], unmatched = [];
    for (let i = 0; i < (fleet || []).length; i++) {
      const fp = fleet[i]; if (!fp) continue;
      const st = String(fp.status || fp.state || "").toLowerCase();
      // A paused print still occupies the machine and its filament - it is
      // in progress, just not moving. Treating it as idle made a tracked job
      // vanish from this report entirely (field, 2026-08-28).
      const paused = /pause/.test(st);
      if (!/print/.test(st) && !paused) continue;
      const fname = String(fp.filename || fp.file || "").split("/").pop();
      if (!fname) continue;
      const label = fp.name || ("printer " + (i + 1));
      // Already tracked? (The background tick adopts too, so by the time a
      // human presses the button most prints are usually claimed already -
      // reporting those as "not in Dispatch" was flatly wrong.)
      const claimed = D.jobs.find(j => j.printing_on === i && j.state === "printing");
      if (claimed) { already.push({ printer: label, file: claimed.file, paused: paused || undefined }); continue; }
      // A machine you took down deliberately does not get handed new work to
      // own, even if something is running on it — you started that print, and
      // Dispatch adopting it would put the job back in a queue that is supposed
      // to be routing around this machine. Report it so it is never invisible.
      if (maintOf(i)) {
        unmatched.push({ printer: label, file: fname, paused: paused || undefined,
                         maintenance: true, why: "down for maintenance — not adopted" });
        continue;
      }
      const job = D.jobs.find(j => j.state !== "done" && j.state !== "paused" &&
                                   j.file === fname && j.printing_on == null);
      if (job) {
        job.state = "printing"; job.printing_on = i;   // claim, don't pin (see tick)
        LAST_STATE.set(i, st);
        adopted.push({ printer: label, file: fname, paused: paused || undefined });
      } else {
        unmatched.push({ printer: label, file: fname, paused: paused || undefined });
      }
    }
    if (adopted.length) save();
    res.json({ ok: true, adopted, already, unmatched, released });
  });
  app.get("/api/dispatch/plan", async (req, res) => {
    try { res.json(await plan()); }
    catch (e) { res.status(500).json({ error: "Plan failed: " + e.message }); }
  });
  // v2.22: FREEZE / UNFREEZE the board (Danny). Locked means the times you
  // approved stop moving: lock snapshots the CURRENT fluid plan's placed slots
  // and the board then serves that snapshot (reconciled for copies that ran or
  // were removed) until you unlock. Locking always re-snapshots from a freshly
  // computed FLUID plan, so "lock" means "lock in exactly what I'm looking at".
  app.post("/api/dispatch/lock", async (req, res) => {
    const b = req.body || {};
    const want = b.lock === undefined ? true : !!b.lock;
    if (!want) {                                   // UNFREEZE - back to the live optimizer
      D.frozen = null;
      D.settings.schedule_mode = "fluid";
      save();
      return res.json({ ok: true, locked: false });
    }
    // Snapshot from a FLUID computation regardless of current mode, so the
    // freeze captures the live optimizer's plan and not a stale frozen one.
    const prevMode = D.settings.schedule_mode;
    D.settings.schedule_mode = "fluid";
    let p;
    try { p = await plan(); }
    catch (e) { D.settings.schedule_mode = prevMode;
                return res.status(500).json({ error: "Could not compute a plan to lock: " + e.message }); }
    const placed = (p.slots || []).filter(s => !s.unplannable);
    D.frozen = { locked_at: Date.now(), slots: placed };
    D.settings.schedule_mode = "locked";
    save();
    res.json({ ok: true, locked: true, locked_at: D.frozen.locked_at, frozen_slots: placed.length });
  });
  // The bed-clear gate. Tapping it (a) clears the awaiting flag, (b) hands the
  // CLIENT the next planned slot for this printer. The client fires /api/print
  // itself — dispatch never bypasses the guarded start path, and never starts
  // anything without this human tap.
  app.post("/api/dispatch/clear-bed", async (req, res) => {
    const idx = parseInt((req.body || {}).printer, 10);
    if (!Number.isInteger(idx)) return res.status(400).json({ error: "Body needs { printer }" });
    AWAITING.delete(idx);
    try {
      const p = await plan();
      const next = (p.slots || []).find(s => s.printer === idx && !s.unplannable) || null;
      res.json({ ok: true, next });
    } catch (e) { res.status(500).json({ error: "Cleared, but planning the next job failed: " + e.message }); }
  });

  ctx.provide("dispatch.jobs", () => D.jobs);
  // v2.20: maintenance is a FLEET fact, not a Dispatch-tab fact. It shipped
  // visible only on the Dispatch guide, so the Dash card for a machine taken
  // out of service still read "IDLE" — you could stand at the Dash, see an idle
  // printer, and send it work you had explicitly said not to send it. Every
  // surface that draws a printer needs this, so it goes on /api/fleet.
  ctx.provide("dispatch.maintenance", () => D.maintenance);
}

module.exports = { register };
