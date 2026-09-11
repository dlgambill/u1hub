// core/events.js — fleet transitions as events (v2.24).
//
// The dashboard already knows when a print finishes, pauses or fails: the
// fleet snapshot says so on every poll. What nothing had was the EDGE — the
// moment a printer went from "printing" to "complete". Two 2.24 features need
// exactly that edge (push notifications, automatic filament deduction), and
// both would otherwise grow their own poller with their own idea of "previous
// state". So the edge is computed once, here, and published on hub.events:
//
//   print.done      { printer, id, filename, durationSec }   complete
//   print.cancelled { printer, id, filename }                 cancelled
//   print.paused    { printer, id, filename, reason }         paused (reason
//                   is the firmware's text when a detector tripped, "" for a
//                   manual pause or a filament-change M600)
//   print.error     { printer, id, filename, reason }
//   printer.offline { printer, id, sinceMs }                  unreachable for
//                   OFFLINE_GRACE_MS — one missed probe is not an outage
//   printer.online  { printer, id }                           back, after an
//                   offline event was raised
//
// Rules. The first snapshot after boot only seeds memory: a Hub restarted
// mid-print must not announce nine "finished" prints it never watched start.
// A printer that is in maintenance still reports (a machine you took down
// on purpose finishing its last job is still news). Events are emitted
// synchronously from one poll, so a listener that throws is caught and logged
// — one bad subscriber cannot stop the others or the poller.

const EventEmitter = require("events");

module.exports = function (hub) {
  const { hublog } = hub;
  const POLL_MS = Number(process.env.U1HUB_EVENTS_POLL_MS) || 5000;
  const OFFLINE_GRACE_MS = Number(process.env.U1HUB_OFFLINE_GRACE_MS) || 90000;

  const events = new EventEmitter();
  events.setMaxListeners(50);
  hub.events = events;

  // id -> { online, state, filename, message, offlineSince, offlineSent, seen }
  const PREV = new Map();
  let seeded = false;
  let RUNNING = false;
  const RECENT = [];            // last 50 emitted, for /api/events and the harness

  function emit(type, payload) {
    const ev = { type, at: Date.now(), ...payload };
    RECENT.push(ev); if (RECENT.length > 50) RECENT.shift();
    try { events.emit(type, ev); events.emit("*", ev); }
    catch (e) { hublog("error", "events: a listener for " + type + " threw: " + (e && e.message || e)); }
    return ev;
  }

  const PRINTING = new Set(["printing", "paused"]);

  // One pass over the fleet. Returns the events it emitted (possibly none).
  async function check() {
    if (RUNNING) return [];
    RUNNING = true;
    const out = [];
    try {
      const fleet = await hub.fleetSnapshot();
      const now = Date.now();
      for (const p of fleet || []) {
        const id = p.id;
        const prev = PREV.get(id);
        const cur = { online: !!p.online, state: String(p.state || ""), filename: p.filename || "", message: p.message || "",
                      durationSec: p.printDuration || 0 };
        if (!prev) { PREV.set(id, { ...cur, offlineSince: 0, offlineSent: false }); continue; }
        if (!seeded) { Object.assign(prev, cur); continue; }
        const base = { printer: p.name, id };
        // --- reachability, debounced ---
        if (!cur.online) {
          if (prev.online || !prev.offlineSince) prev.offlineSince = prev.offlineSince || now;
          if (!prev.offlineSent && now - prev.offlineSince >= OFFLINE_GRACE_MS) {
            prev.offlineSent = true;
            out.push(emit("printer.offline", { ...base, sinceMs: prev.offlineSince }));
          }
        } else {
          if (prev.offlineSent) out.push(emit("printer.online", base));
          prev.offlineSince = 0; prev.offlineSent = false;
        }
        // --- print state edges (only while both sides are real readings) ---
        if (prev.online && cur.online && prev.state !== cur.state) {
          const file = cur.filename || prev.filename;
          if (PRINTING.has(prev.state) && cur.state === "complete")
            out.push(emit("print.done", { ...base, filename: file, durationSec: cur.durationSec || prev.durationSec }));
          else if (PRINTING.has(prev.state) && cur.state === "cancelled")
            out.push(emit("print.cancelled", { ...base, filename: file }));
          else if (cur.state === "paused" && prev.state === "printing")
            out.push(emit("print.paused", { ...base, filename: file, reason: cur.message }));
          else if (cur.state === "error" && prev.state !== "error")
            out.push(emit("print.error", { ...base, filename: file, reason: cur.message }));
          else if (cur.state === "printing" && !PRINTING.has(prev.state))
            out.push(emit("print.started", { ...base, filename: file }));
        } else if (prev.online && cur.online && cur.state === "paused" && prev.state === "paused" && cur.message && cur.message !== prev.message) {
          // A second detector fired while already paused (rare, but the
          // reason changed and the person watching should hear the new one).
          out.push(emit("print.paused", { ...base, filename: cur.filename, reason: cur.message }));
        }
        Object.assign(prev, cur);
      }
      // Printers removed from config stop being tracked.
      const live = new Set((fleet || []).map(p => p.id));
      for (const id of [...PREV.keys()]) if (!live.has(id)) PREV.delete(id);
      seeded = true;
    } catch (e) {
      hublog("warn", "events: poll failed - " + (e && e.message || e));
    } finally { RUNNING = false; }
    return out;
  }

  hub.eventsCheck = check;
  hub.eventsRecent = () => RECENT.slice();

  // Harness hook and a debugging aid: force one pass now, answer with what it
  // raised. Also lists the recent events so a person can see what the Hub has
  // noticed without tailing a log.
  // NOT /api/events: that is the dashboard's Server-Sent-Events stream in
  // core/fleet.js (an always-open response, so a GET there never "returns").
  hub.app.post("/api/fleet-events/check", async (req, res) => res.json({ emitted: await check(), recent: RECENT.slice(-20) }));
  hub.app.get("/api/fleet-events", (req, res) => res.json({ recent: RECENT.slice(-50), poll_ms: POLL_MS, offline_grace_ms: OFFLINE_GRACE_MS }));

  // First pass shortly after boot seeds memory; the farm socket cache is warm
  // by then. unref so nothing here keeps a shutting-down process alive.
  const t0 = setTimeout(() => { check().catch(() => {}); }, 2500);
  if (t0.unref) t0.unref();
  const timer = setInterval(() => { check().catch(() => {}); }, POLL_MS);
  if (timer.unref) timer.unref();
};
