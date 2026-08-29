// modules/dispatch.js — the scheduler (v2.11). PrintFarm's workflow, reborn as
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
const PLAN_SLOT_CAP = 200;                       // sanity cap on plan expansion
const EXEC_TICK_MS = 10000;                      // completion watcher (probe caches make this cheap)

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
    auto_start: false
  };
  let D = { jobs: [], bundles: [], settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    D.jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    D.bundles = Array.isArray(raw.bundles) ? raw.bundles : [];
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
  function save() {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(D, null, 2));
    fs.renameSync(tmp, FILE);                    // atomic on the same volume
  }
  const newId = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // Sticky placement: a plan is something a human reads and acts on, so it
  // must not reshuffle every time anything happens. Once a job-copy has been
  // assigned a printer we keep that assignment across replans; it's only
  // dropped when the job finishes, the printer goes offline/ineligible, or the
  // user explicitly moves it. Times still float (that's real information) -
  // WHICH MACHINE does not.
  const PINS = new Map();   // job.id -> printer index
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
  // once. The Hub has no inventory count (Danny, 2026-08-28), so the honest
  // assumption is ONE roll per distinct colour unless a tray somewhere is
  // already showing it. Two jobs needing black therefore cannot overlap.
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
      return { idx: x.i, name: x.fp.name || ("printer " + (x.i + 1)),
               multiColor: !!(x.fp.caps && x.fp.caps.multiColor), fp: x.fp, cursor, note };
    });
    // Bundle deadlines tighten members'.
    const bundleDeadline = {};
    for (const b of D.bundles) if (b.deadline) bundleDeadline[b.id] = b.deadline;
    const effDeadline = j => {
      const bd = j.bundle_id ? bundleDeadline[j.bundle_id] : null;
      if (j.deadline && bd) return Math.min(j.deadline, bd);
      return j.deadline || bd || null;
    };
    // EDF within priority.
    const runnable = D.jobs.filter(j => j.state === "queued" || j.state === "scheduled" || j.state === "printing");
    const ordered = [...runnable].sort((a, b) =>
      (b.priority || 0) - (a.priority || 0) ||
      ((effDeadline(a) || Infinity) - (effDeadline(b) || Infinity)) ||
      (a.created - b.created));
    const slots = [];
    const placed = [];      // [{start,end,colors,printerName,file}] for exclusivity checks
    for (const job of ordered) {
      // A copy a machine is printing RIGHT NOW is already accounted for -
      // subtract it so the planner never schedules work the farm is doing.
      const inFlight = job.printing_on != null ? 1 : 0;
      const copies = Math.max(0, (job.remaining ?? job.qty ?? 1) - inFlight);
      const est = job.est_minutes || 60;         // unknown estimate: assume an hour, honestly labeled
      for (let c = 0; c < copies; c++) {
        if (slots.length >= PLAN_SLOT_CAP) break;
        const eligible = lanes.filter(l => !job.multi || l.multiColor);
        if (!eligible.length) { slots.push({ job_id: job.id, file: job.file, unplannable: "no eligible printer (multi-color job, no multi-color machine online)" }); continue; }
        let best = null;
        const pinned = PINS.get(job.id);
        const pool = (pinned !== undefined && eligible.some(l => l.idx === pinned))
                   ? eligible.filter(l => l.idx === pinned)   // honor the sticky choice
                   : eligible;
        for (const l of pool) {
          const strict = !!job.needs_finish || D.settings.finish_policy === "attended";
          // Walk forward through attended blocks looking for one the job FITS
          // in. Under the default "anytime" policy a long print may legitimately
          // overrun its block (that's the whole point - prints run while you're
          // out), but overrunning should be a CONSEQUENCE of a job being longer
          // than any block, never a preference: don't start at 08:00 in a
          // one-hour window when a 62-minute job fits cleanly at 17:00.
          let start = nextStart(Math.max(l.cursor, now));
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
          const cand = { lane: l, start: realStart, end: realEnd, swaps, cost };
          if (!best || cost < best.cost) best = cand;
        }
        if (!best) { slots.push({ job_id: job.id, file: job.file, unplannable: "no attended window found within 14 days" }); continue; }
        const dl = effDeadline(job);
        const held = colorsHeld(job);
        const clash = findContention(held, best.start, best.end, placed);
        placed.push({ start: best.start, end: best.end, colors: held,
                      printerName: best.lane.name, file: job.file });
        slots.push({
          job_id: job.id, file: job.file, type: job.type, copy: c + 1, of: copies,
          printer: best.lane.idx, printerName: best.lane.name,
          est_start: best.start, est_end: best.end, est_minutes: est,
          est_assumed: !job.est_minutes || undefined,
          swaps: best.swaps, deadline: dl, pinned: pinned !== undefined || undefined,
          // A physical roll can't be in two machines at once. Flagged, not
          // silently rescheduled - the human decides what to do about it.
          contention: clash ? { color: clash.color, printer: clash.printer,
                                file: clash.file, until: clash.until } : undefined,
          // how long this machine then waits for a human to clear the bed
          idle_after_min: Math.max(0, Math.round((readyAfter(best.end) - best.end - BED_CLEAR_BUFFER_MIN * 60000) / 60000)) || undefined,
          misses_deadline: !!(dl && best.end > dl),
          lane_note: best.lane.note || undefined
        });
        PINS.set(job.id, best.lane.idx);
        const ready = readyAfter(best.end);
        best.lane.cursor = ready;
        best.lane.fp = { ...best.lane.fp };      // after a planned run the trays hold the job's colors
        best.lane.fp.heads = (job.colors || []).map(h => ({ hex: norm(h) }));
      }
    }
    // Report the whole fleet, not just the machines that got work: an idle
    // printer vanishing from the timeline hides exactly the capacity problem
    // the scheduler exists to surface.
    return { generated_at: now, slots,
             printers: lanes.map(l => ({ idx: l.idx, name: l.name, busy: !!l.note || l.cursor > now })) };
  }

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
          job.state = job.remaining > 0 ? "queued" : "done";
          if (job.state === "done") PINS.delete(job.id);
          job.printing_on = null;
          dirty = true;
          ctx.hublog("info", "dispatch: '" + job.file + "' copy done on printer " + (i + 1) +
            " — " + job.remaining + " remaining; bed-clear gate armed");
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
      if ((/print/.test(st) || /pause/.test(st)) && fname && !heldHere) {
        const job = D.jobs.find(j => j.state !== "done" && j.state !== "paused" &&
                                     j.file === fname && j.printing_on == null);
        if (job) {
          const adopting = !(prev && !/print/.test(prev));
          job.state = "printing"; job.printing_on = i; PINS.set(job.id, i); dirty = true;
          if (adopting) ctx.hublog("info", "dispatch: adopted in-progress '" + job.file +
            "' on printer " + (i + 1) + " (it was already running)");
        }
      }
    }
    if (dirty) save();
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, EXEC_TICK_MS);
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
               awaiting: [...AWAITING], auto_start_available: false });
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
      priority: parseInt(b.priority, 10) || 0,
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
    if (b.priority !== undefined) j.priority = parseInt(b.priority, 10) || 0;
    if (b.needs_finish !== undefined) j.needs_finish = !!b.needs_finish;
    if (b.state === "paused" || b.state === "queued") { if (j.state !== "printing") j.state = b.state; }
    save(); res.json({ ok: true, job: j });
  });
  app.post("/api/dispatch/jobs/remove", (req, res) => {
    PINS.delete((req.body || {}).id);
    const n = D.jobs.length;
    D.jobs = D.jobs.filter(x => x.id !== (req.body || {}).id);
    if (D.jobs.length === n) return res.status(404).json({ error: "Unknown job" });
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
        deadline: null, priority: parseInt(b.priority, 10) || 0, bundle_id: bundle.id,
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
    if (j.state === "printing") j.state = j.remaining > 0 ? "queued" : "done";
    PINS.delete(j.id);
    save();
    ctx.hublog("info", "dispatch: released '" + j.file + "' from printer " +
      (was == null ? "(none)" : was + 1) + " - free to be re-claimed");
    res.json({ ok: true, released_from: was, job: j });
  });
  app.post("/api/dispatch/jobs/assign", (req, res) => {
    const b = req.body || {};
    const j = D.jobs.find(x => x.id === b.id);
    if (!j) return res.status(404).json({ error: "Unknown job" });
    if (b.printer === null || b.printer === "auto") { PINS.delete(j.id); return res.json({ ok: true, pinned: null }); }
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
      const job = D.jobs.find(j => j.state !== "done" && j.state !== "paused" &&
                                   j.file === fname && j.printing_on == null);
      if (job) {
        job.state = "printing"; job.printing_on = i; PINS.set(job.id, i);
        LAST_STATE.set(i, st);
        adopted.push({ printer: label, file: fname, paused: paused || undefined });
      } else {
        unmatched.push({ printer: label, file: fname, paused: paused || undefined });
      }
    }
    if (adopted.length) save();
    res.json({ ok: true, adopted, already, unmatched });
  });
  app.get("/api/dispatch/plan", async (req, res) => {
    try { res.json(await plan()); }
    catch (e) { res.status(500).json({ error: "Plan failed: " + e.message }); }
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
}

module.exports = { register };
