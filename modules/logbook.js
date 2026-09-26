// modules/logbook.js - the printer logbook and maintenance schedule (v2.37).
//
// Asked for by a user (ezpitze, Reddit, 2026-09-26): "a log of issues solved
// on them, when, what and solution for future reference. And also a
// maintenance schedule/log to see what the maintenance has been, with maybe
// notifications to actually do what and when."
//
// Two things, one file (logbook.json, beside config, gitignored):
//
//   ENTRIES - what happened to a printer and what fixed it. Written by hand,
//   and written by the Hub where it already knows something happened:
//     * a firmware pause or error that carries a reason (core/events.js
//       already computes those edges, with the detector's own words) opens an
//       issue with the reason as "what" - the person adds the fix;
//     * taking a printer out of service (Dispatch's maintenance mode) opens an
//       issue with the note; bringing it back marks it back in service and the
//       tab asks "what fixed it?".
//   Each entry records the printer's print hours at the time, so "the second
//   clog in 200 hours" is readable later. Search over what + fix is the
//   "for future reference" half: type "clog" and see how it was solved before.
//
//   TASKS - upkeep that comes round again: every N print hours, every N days,
//   or both (whichever comes first). A task is for one printer or for all of
//   them; each printer keeps its own "last done". Print hours come from each
//   printer's own Moonraker history totals (total_print_time), which is the
//   honest clock for wear - calendar days are there for the things that age
//   regardless (a bed wipe, a desiccant swap). Marking a task done writes a
//   maintenance entry, so the schedule and the log are one history.
//   When a task comes due on a printer, ntfy says so once (notify.send, the
//   "maintenance" event in the notify settings); it says so again only after
//   the task has been done and come due again.
//
// Deliberately not here: parts inventory, costs, work orders, assignees. This
// is a record and a reminder for one person running a farm, not a CMMS.
//
// Printers are keyed by index, the same key Dispatch's maintenance mode uses,
// with the name kept on each entry so the log still reads right if printers
// are renamed. Every filesystem call is on the local state file; the only
// network calls are the per-printer totals fetches, async, 3.5 s each, in
// parallel, at most every 10 minutes (or on demand from the tab).

"use strict";

const fs = require("fs");
const path = require("path");

const HOURS_TTL_MS = 10 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
const SOON = 0.85;                         // "coming up" once 85% of the interval is used
const DEDUPE_MS = 30 * 60 * 1000;          // the same firmware reason twice in 30 min is one issue
const MAX_ENTRIES = 5000;
const KINDS = ["issue", "maintenance", "note"];

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n || 500);
const posNum = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

// Where one task stands on one printer. Pure; exported for the harness.
//   task: { every_hours, every_days, done: { [idx]: { at, hours } } }
//   hoursNow: that printer's print hours now (null when never read)
// -> { status: "ok"|"soon"|"due"|"unknown", frac, since_hours, since_days, left_hours, left_days }
// Whichever interval runs out first decides. With no record for the printer
// (a task added before the printer existed) it counts from never: due.
function dueOf(task, idx, hoursNow, now) {
  const d = task.done && task.done[String(idx)];
  const out = { status: "ok", frac: 0, since_hours: null, since_days: null, left_hours: null, left_days: null };
  if (!d) return { ...out, status: "due", frac: Infinity };
  let frac = 0, known = false;
  if (task.every_days) {
    out.since_days = Math.max(0, (now - d.at) / 86400000);
    out.left_days = task.every_days - out.since_days;
    frac = Math.max(frac, out.since_days / task.every_days);
    known = true;
  }
  if (task.every_hours) {
    if (hoursNow != null && d.hours != null) {
      out.since_hours = Math.max(0, hoursNow - d.hours);
      out.left_hours = task.every_hours - out.since_hours;
      frac = Math.max(frac, out.since_hours / task.every_hours);
      known = true;
    } else if (!task.every_days) return { ...out, status: "unknown" };
  }
  if (!known) return { ...out, status: "unknown" };
  out.frac = frac;
  out.status = frac >= 1 ? "due" : frac >= SOON ? "soon" : "ok";
  return out;
}
// Which printers a task applies to.
const appliesTo = (task, count) => task.printer === "all" ? [...Array(count).keys()] : [Number(task.printer)].filter(i => i >= 0 && i < count);

function register(ctx) {
  const FILE = path.join(ctx.baseDir, "logbook.json");
  let L = { entries: [], tasks: [], hours: {} };
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (j && typeof j === "object") L = { entries: Array.isArray(j.entries) ? j.entries : [], tasks: Array.isArray(j.tasks) ? j.tasks : [], hours: (j.hours && typeof j.hours === "object") ? j.hours : {} };
  } catch {}
  // Direct write, not tmp+rename: the state dir may be a share, where
  // rename-over-existing silently fails (MISTAKES.md 2026-09-01).
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(L, null, 1)); } catch (e) { ctx.hublog("warn", "logbook: save failed - " + e.message); } };
  const newId = p => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const printers = () => ctx.printers || [];
  const nameOf = i => (printers()[i] && printers()[i].name) || ("printer " + (Number(i) + 1));
  const hoursOf = i => { const h = L.hours[String(i)]; return h && Number.isFinite(h.hours) ? h.hours : null; };

  // ---- print hours, from each printer's Moonraker totals -----------------------
  let HOURS_AT = 0, HOURS_BUSY = null;
  async function refreshHours(force) {
    if (!force && HOURS_AT && Date.now() - HOURS_AT < HOURS_TTL_MS) return;
    if (HOURS_BUSY) return HOURS_BUSY;
    HOURS_BUSY = Promise.all(printers().map(async (p, i) => {
      const base = String(p.url || "").replace(/\/+$/, "");
      if (!base) return;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3500);
      try {
        const r = await fetch(base + "/server/history/totals", { signal: ac.signal });
        if (!r.ok) return;
        const tot = ((((await r.json()) || {}).result || {}).job_totals) || {};
        if (Number.isFinite(tot.total_print_time)) L.hours[String(i)] = { hours: Math.round(tot.total_print_time / 36) / 100, at: Date.now() };
      } catch {} finally { clearTimeout(t); }
    })).then(() => {
      HOURS_AT = Date.now();
      // Baselines taken before a printer's hours were ever read count from the
      // first reading; a printer added to the farm after an "all printers"
      // task was made starts that task's clock now, not as overdue.
      const n = printers().length;
      for (const t of L.tasks) {
        t.done = t.done || {};
        for (const i of appliesTo(t, n)) {
          const d = t.done[String(i)];
          if (d && d.hours == null && hoursOf(i) != null) d.hours = hoursOf(i);
          if (!d && !t.due_now) t.done[String(i)] = { at: Date.now(), hours: hoursOf(i) };
        }
      }
      save();
    }).finally(() => { HOURS_BUSY = null; });
    return HOURS_BUSY;
  }

  // ---- entries --------------------------------------------------------------
  function addEntry(e) {
    const i = Number(e.printer);
    const entry = {
      id: newId("log"), printer: i, name: nameOf(i), kind: KINDS.includes(e.kind) ? e.kind : "note",
      at: Number.isFinite(+e.at) && +e.at > 0 ? +e.at : Date.now(),
      what: clean(e.what, 500), fix: clean(e.fix, 1000), source: e.source || "you",
      hours: hoursOf(i)
    };
    if (e.fix) entry.fixed_at = Date.now();
    if (e.task_id) entry.task_id = e.task_id;
    if (e.file) entry.file = clean(e.file, 200);
    L.entries.push(entry);
    if (L.entries.length > MAX_ENTRIES) L.entries.splice(0, L.entries.length - MAX_ENTRIES);
    save();
    return entry;
  }

  // Firmware pauses and errors with a reason open an issue. A manual pause or
  // an M600 filament change has no reason and is not an issue.
  if (ctx.events) {
    const fromEvent = ev => {
      const reason = clean(ev.reason, 300);
      if (!reason || !Number.isInteger(ev.id)) return;
      const dup = L.entries.some(x => x.printer === ev.id && x.source === "firmware" && x.what === reason && Date.now() - x.at < DEDUPE_MS);
      if (dup) return;
      addEntry({ printer: ev.id, kind: "issue", what: reason, source: "firmware", file: ev.filename });
      ctx.hublog("info", "logbook: " + nameOf(ev.id) + " - " + (ev.type === "print.error" ? "error" : "paused") + ": " + reason);
    };
    ctx.events.on("print.paused", fromEvent);
    ctx.events.on("print.error", fromEvent);
    // Dispatch's maintenance mode (modules/dispatch.js emits this).
    ctx.events.on("printer.maintenance", ev => {
      const i = Number(ev.id);
      if (!Number.isInteger(i)) return;
      const open = [...L.entries].reverse().find(x => x.printer === i && x.source === "maintenance-mode" && !x.back_at);
      if (ev.down) {
        if (open) { if (ev.note && ev.note !== open.what) { open.what = clean(ev.note, 500); save(); } return; }
        addEntry({ printer: i, kind: "issue", what: ev.note || "Taken out of service", source: "maintenance-mode", at: ev.since });
      } else if (open) {
        open.back_at = Date.now();
        if (ev.fix) { open.fix = clean(ev.fix, 1000); open.fixed_at = Date.now(); }
        save();
      }
    });
  }

  // ---- tasks ------------------------------------------------------------------
  function baseline(task) {
    // A new task counts from NOW on every printer it covers - a two-year-old
    // printer is not instantly "overdue" for something just added - unless
    // the person says it has never been done (due: true).
    task.done = task.done || {};
    for (const i of appliesTo(task, printers().length))
      if (!task.done[String(i)]) task.done[String(i)] = { at: Date.now(), hours: hoursOf(i) };
  }
  function statusRows(now) {
    const n = printers().length, rows = [];
    for (const t of L.tasks) for (const i of appliesTo(t, n)) {
      const d = dueOf(t, i, hoursOf(i), now);
      rows.push({ task_id: t.id, title: t.title, printer: i, name: nameOf(i), every_hours: t.every_hours || null, every_days: t.every_days || null,
                  last: t.done && t.done[String(i)] || null, ...d });
    }
    return rows;
  }
  // What the printer card shows: counts and the most pressing title.
  function cards(now) {
    const out = {};
    const rank = { due: 3, soon: 2, unknown: 1, ok: 0 };
    for (const r of statusRows(now || Date.now())) {
      if (r.status !== "due" && r.status !== "soon") continue;
      const c = out[String(r.printer)] || (out[String(r.printer)] = { due: 0, soon: 0, next: null, nextStatus: null, nextFrac: -1 });
      c[r.status]++;
      const score = rank[r.status] * 10 + Math.min(r.frac === Infinity ? 9 : r.frac, 9);
      if (score > c.nextFrac) { c.nextFrac = score; c.next = r.title; c.nextStatus = r.status; }
    }
    for (const k of Object.keys(out)) delete out[k].nextFrac;
    return out;
  }

  // ---- due notifications --------------------------------------------------------
  async function checkDue() {
    await refreshHours(false);
    const send = ctx.use("notify.send"), state = ctx.use("notify.state");
    const st = state ? state() : null;
    const wanted = st && st.ready && st.events && st.events.maintenance !== false;
    let dirty = false;
    for (const r of statusRows(Date.now())) {
      if (r.status !== "due") continue;
      const t = L.tasks.find(x => x.id === r.task_id);
      const stamp = r.last ? r.last.at : 0;              // one ping per "cycle": until it is done again
      t.notified = t.notified || {};
      if (t.notified[String(r.printer)] === stamp) continue;
      t.notified[String(r.printer)] = stamp; dirty = true;
      if (!wanted || !send) continue;
      const how = [r.every_hours ? "every " + r.every_hours + " print hours" : "", r.every_days ? "every " + r.every_days + " days" : ""].filter(Boolean).join(" or ");
      const since = [r.since_hours != null ? Math.round(r.since_hours) + " h printed" : "", r.since_days != null ? Math.round(r.since_days) + " days" : ""].filter(Boolean).join(", ");
      send({ title: r.name + ": " + r.title + " is due", body: (how ? how.charAt(0).toUpperCase() + how.slice(1) : "") + (since && r.last ? " - " + since + " since it was last done" : " - no record of it being done"), priority: 3, tags: "wrench" }).catch(() => {});
    }
    if (dirty) save();
  }
  const timer = setInterval(() => { checkDue().catch(() => {}); }, CHECK_MS);
  if (timer.unref) timer.unref();
  const t0 = setTimeout(() => { checkDue().catch(() => {}); }, 20000);
  if (t0.unref) t0.unref();

  // ---- routes -------------------------------------------------------------------
  const view = () => {
    const now = Date.now();
    return {
      printers: printers().map((p, i) => ({ idx: i, name: nameOf(i), hours: hoursOf(i), hours_at: (L.hours[String(i)] || {}).at || null })),
      tasks: L.tasks.map(t => ({ id: t.id, title: t.title, printer: t.printer, every_hours: t.every_hours || null, every_days: t.every_days || null, notes: t.notes || "", created: t.created })),
      status: statusRows(now),
      entries: L.entries.slice().sort((a, b) => b.at - a.at).slice(0, 1000),
      total_entries: L.entries.length,
      hours_at: HOURS_AT || null
    };
  };
  ctx.app.get("/api/logbook", async (req, res) => {
    if (String((req.query || {}).refresh || "") === "1") { await refreshHours(true); await checkDue().catch(() => {}); }
    else refreshHours(false).catch(() => {});
    res.json(view());
  });
  ctx.app.post("/api/logbook/entries", (req, res) => {
    const b = req.body || {};
    const i = parseInt(b.printer, 10);
    if (!Number.isInteger(i) || i < 0 || i >= printers().length) return res.status(400).json({ error: "Pick a printer" });
    if (!clean(b.what)) return res.status(400).json({ error: "Say what happened" });
    res.json({ ok: true, entry: addEntry({ printer: i, kind: b.kind, what: b.what, fix: b.fix, at: b.at }) });
  });
  ctx.app.post("/api/logbook/entries/update", (req, res) => {
    const b = req.body || {};
    const e = L.entries.find(x => x.id === b.id);
    if (!e) return res.status(404).json({ error: "No such entry" });
    if ("fix" in b) { e.fix = clean(b.fix, 1000); e.fixed_at = e.fix ? Date.now() : undefined; }
    if ("what" in b && clean(b.what)) e.what = clean(b.what, 500);
    if ("kind" in b && KINDS.includes(b.kind)) e.kind = b.kind;
    save();
    res.json({ ok: true, entry: e });
  });
  ctx.app.post("/api/logbook/entries/remove", (req, res) => {
    const n = L.entries.length;
    L.entries = L.entries.filter(x => x.id !== (req.body || {}).id);
    if (L.entries.length === n) return res.status(404).json({ error: "No such entry" });
    save(); res.json({ ok: true });
  });
  ctx.app.post("/api/logbook/tasks", (req, res) => {
    const b = req.body || {};
    const title = clean(b.title, 120);
    if (!title) return res.status(400).json({ error: "Name the task" });
    const every_hours = posNum(b.every_hours), every_days = posNum(b.every_days);
    if (!every_hours && !every_days) return res.status(400).json({ error: "Give it an interval: print hours, days, or both" });
    const printer = b.printer === "all" || b.printer == null ? "all" : parseInt(b.printer, 10);
    if (printer !== "all" && !(Number.isInteger(printer) && printer >= 0 && printer < printers().length)) return res.status(400).json({ error: "Pick a printer, or all" });
    const t = { id: newId("task"), title, printer, every_hours, every_days, notes: clean(b.notes, 500), created: Date.now(), done: {} };
    if (b.due_now) t.due_now = true; else baseline(t);
    L.tasks.push(t); save();
    res.json({ ok: true, task: t, view: view() });
  });
  ctx.app.post("/api/logbook/tasks/update", (req, res) => {
    const b = req.body || {};
    const t = L.tasks.find(x => x.id === b.id);
    if (!t) return res.status(404).json({ error: "No such task" });
    if ("title" in b && clean(b.title)) t.title = clean(b.title, 120);
    if ("every_hours" in b) t.every_hours = posNum(b.every_hours);
    if ("every_days" in b) t.every_days = posNum(b.every_days);
    if (!t.every_hours && !t.every_days) return res.status(400).json({ error: "A task needs an interval" });
    if ("notes" in b) t.notes = clean(b.notes, 500);
    save(); res.json({ ok: true, task: t });
  });
  ctx.app.post("/api/logbook/tasks/remove", (req, res) => {
    const n = L.tasks.length;
    L.tasks = L.tasks.filter(x => x.id !== (req.body || {}).id);
    if (L.tasks.length === n) return res.status(404).json({ error: "No such task" });
    save(); res.json({ ok: true });
  });
  // Done on one printer: resets its clock and writes a maintenance entry.
  ctx.app.post("/api/logbook/tasks/done", async (req, res) => {
    const b = req.body || {};
    const t = L.tasks.find(x => x.id === b.id);
    if (!t) return res.status(404).json({ error: "No such task" });
    const i = parseInt(b.printer, 10);
    if (!appliesTo(t, printers().length).includes(i)) return res.status(400).json({ error: "That task does not cover that printer" });
    await refreshHours(true);
    t.done = t.done || {};
    t.done[String(i)] = { at: Date.now(), hours: hoursOf(i) };
    const entry = addEntry({ printer: i, kind: "maintenance", what: t.title, fix: b.note || "", source: "schedule", task_id: t.id });
    save();
    res.json({ ok: true, entry, status: statusRows(Date.now()).filter(r => r.task_id === t.id && r.printer === i)[0] });
  });

  ctx.provide("logbook.cards", () => cards(Date.now()));
  ctx.provide("logbook.add", e => addEntry(e));
}

module.exports = { register, dueOf, appliesTo, SOON };
