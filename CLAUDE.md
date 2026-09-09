# CLAUDE.md — U1 Print Hub

## Mistake log

Log mistakes in `MISTAKES.md` (what happened, root cause, prevention). Newest
first. Read it before touching an area you have broken before. When the same
failure appears 4–5 times, promote it to a hard rule below.

## Other sessions on this machine

Danny runs more than one Claude session against ichabod at once, and they
cannot see each other. **Read `C:\Users\Danny\code\SESSIONS.md` after this file
and `MISTAKES.md`, whatever repo you are working in.** It carries an ownership
register for shared resources — which session owns which repo, table and
service — plus open questions between sessions and their answers.

Append to it (never rewrite) when you take a shared resource, answer another
session's question, or find something that affects a repo you do not own. It
exists because two sessions were writing to `dlgambill/conduitlab-site` for
months and neither knew.

## Visual standard

**Read `C:\Users\Danny\code\DESIGN.md` before building or changing anything with
a user-facing surface**, whatever repo you are in. It is the VibeCurb
constraint approach (github.com/Yu-369/VibeCurb) Danny wants applied to every
project instead of framework defaults: extract the design signals before writing
code, refuse the banned defaults (CSS keyword easings, AI-purple gradients,
generic dashboard layouts, weak typographic hierarchy), and verify the result
against the extraction rather than against a general impression.

It also records which VibeCurb skills are actually installed on the account, so
you do not offer one that cannot be invoked.

## Where durable instructions belong

Put anything a future session must know in a FILE that this file points to —
never in a scheduled task's prompt. A task with computer access can only have
its prompt changed by Danny, in a conversation running inside the Claude desktop
app on ichabod, and he is usually not at ichabod. Files need no approval and
take effect on the next session. This section exists because a session tried to
add SESSIONS.md and DESIGN.md to the `ichabod on demand` prompt, hit
`needs_device_approval` twice, and only then noticed the prompt already reads
this file.

**There is one tree: `C:\Users\Danny\code\u1-print-hub`, this git clone.**
Edit here, run the Hub from here (port 4545), commit here. Danny retired the
`X:\u1-print-hub` staging copy on 2026-09-09 after the two-tree arrangement
cost real bugs (rfid.js shipped five releases stale; this file diverged in both
directions in one week). The gcode library moved to **`X:\gcode`** and
`config.json` points at it; everything else the Hub remembers (config, spools,
slots, schedule, password, tunnel, thumbnail cache) sits in this directory,
gitignored. `scripts/sync-to-clone.js` and `scripts/drift-scan.js` are stubs
that say so. If `X:\u1-print-hub` (or a `_RETIRED` rename of it) still exists,
it is dead weight waiting for Danny to delete it - never read from it.

`MISTAKES.md` is this repo's public log, so a mistake made in another project
goes in that project's log or in `C:\Users\Danny\code\MISTAKES-shared.md`, not
here.

## Hard rules

1. **Rule #1 — read before writing.** Read every file you are about to change,
   in full, before the first edit. No patching from memory or from a grep hit.
   **And read what it loads.** A file's behaviour is the whole chain it pulls
   in — resolve every `<link>`, `<script src>`, `require` and `import` before
   concluding anything, especially before claiming something is absent. An
   "there is no X here" claim is a whole-project claim; a count from one file is
   not evidence for it. (2026-09-01: audited index.html, missed the gold.css it
   links one line later, and reported a stylesheet that already existed as
   missing.)
2. **Nothing ships unverified.** "Built" is not "shippable." A feature is done
   when the harness is green *and* its live hardware gate has passed. Unverified
   shapes and paths are not emitted at all.
3. **This clone is the only tree** (since 2026-09-09; see above). Code is read,
   edited, run and committed in `C:\Users\Danny\code\u1-print-hub`. Never
   build or reason from GitHub main instead of the working copy, and never
   from a retired staging folder on `X:`. The gcode library is `X:\gcode`; the
   Hub's state files live beside the code and are gitignored. The `X:` share
   refuses rename-over-existing, which is why state writers use the fallback
   in `modules/dispatch.js` `save()` - that constraint now applies only to
   files the Hub writes under `X:\gcode`, not to its state, which is local.
4. **Version bumps are atomic.** `server.js`, `public/index.html`, and
   `package.json` change in the same pass, then `npm test`.
5. **Never commit state files.** config.json, spools.json, slots.json, auth.json,
   queue.json, printlog.json, tunnel.json, dispatch.json, slicejobs.json,
   resources.json.
   Commit with explicit `git add` — never `git add -A`.
6. **A new check must be shown to fail.** Write it, watch it go red against a
   deliberately wrong expectation, then fix the expectation. A check that has
   only ever been green is not evidence — v2.12's `×` vs `x` regex was green-by-
   construction for weeks and gated a ship (`MISTAKES.md`).
7. **A test must not depend on when it runs or what else is running.** Not the
   wall clock, not a background tick, not state left by an earlier section.
   Derive every expectation from what the system under test actually produced.
   If an assertion's truth changes between 14:00 and 23:02, or between two runs
   of the same commit, the assertion is wrong — not flaky. **"Re-run before
   believing it" is a bug report, not a mitigation**, and a documented exception
   to the ship gate is how a real failure gets waved through. Removing
   `Date.now()` from the comparison is not enough on its own: ask what the
   assertion means at 23:59, because the PLAN can change shape near a window
   edge even when the arithmetic no longer mentions the clock. Five checks
   across four incidents (`MISTAKES.md` 2026-08-30, 2026-08-31 ×2).
8. **Verify before you assert or act.** One `list`, one `grep`, one read is
   always cheaper than the consequence. This covers claims about what a file
   contains, recursive or destructive commands, "that isn't possible"
   statements, and "it's green". Check first, then say it. If it cannot be
   checked, say "I don't know" and name what would settle it — never substitute
   an inference and present it as the reason. Four incidents: an unread config
   argued from twice, a `robocopy /E` that put 30 GB on the C: drive, a task
   handed back that this repo already documents how to do, and a harness called
   green while its check count sat unchanged. Fifth: a UI audit that counted one
   file and reported the total as the project's, calling a stylesheet absent
   that had shipped nine days earlier. Sixth: a backlog item quoted as still
   open, twice, that measurement showed had already been fixed — a note is not
   evidence, and re-measure before you work it or repeat it.

## Core layout (v2.23)

`server.js` is a ~90-line composition root. The always-on core lives in
`core/*.js`, loaded **in this exact order** — it is the order the code had in
the old single file, and load-time statements depend on it (`loadConfig()`
before `PORT` reads `CFG.port`; middleware before routes; the module loader
and `listen` last):

`log` → `config` → `records` → `app` → `library` → `print` → `fleet` →
`telemetry` → `thumbs` → `filament` → `network` → `settings` → `modules`

Every file is `module.exports = function (hub) { ... }` and shares one `hub`
object. The contract:

- **Mutable globals live on `hub`** and are always written/read as
  `hub.CFG`, `hub.FOLDER`, `hub.PRINTERS`, `hub.TYPES`, `hub.TYPE_WARNINGS`,
  `hub.FEATURES`, `hub.QUEUE`, `hub.FARM_READY`. CommonJS cannot share a
  reassigned binding, so a bare `PRINTERS` in a core file is a bug.
- **Everything else** a file needs from an *earlier* file is destructured once
  at the top (`const { app, hublog, safeFile } = hub;`). A reference to a
  *later* file's export must go through `hub.name` at call time (the only
  live cases: `hub.farmWsRestart` from config, guarded by `FARM_READY`;
  `hub.safeFile` from records; `hub.JOBS` from library; `hub.CAPS_PROVIDED`
  from fleet).
- A file publishes with `Object.assign(hub, { ... })` at its end.
- New always-on code goes in the file that owns the concern; a new optional
  feature is still a `modules/*.js` feature module.
- `core/` must be in the Dockerfile `COPY` list and in the harness's
  `stageHub()` mirror of it — the "boot from the Docker COPY file set" check
  is what catches a missing directory.

The split was mechanical: `scripts/split-core.js` produced it from the
pre-split `server.js` (dry run reports the dependency surface; `--apply`
writes). `scripts/check-core.js` syntax-checks the root plus every core file.

## Harness

`npm test` → **553 checks**, expect **553 passed, 0 failed**. A red harness
blocks everything.

Takes ~2.5 min over SMB. Run it with `scripts/run-harness.cmd` and poll
`scripts/harness.log` — see **Working over the bridge** below for why.
`node scripts/check-index-js.js` is the companion check for
`public/index.html`: `node --check` only covers `.js`, so a typo in the page's
own 2,400-line inline script would otherwise ship silently.

Standalone suites — `npm run test:standalone` runs all of them in one go
(added 2026-09-01, because "run directly" had come to mean "never run"):
`test/amounts-standalone.js` (44, real gcode) · `test/resources-standalone.js` ·
`test/de-nearwhite-standalone.js` (the ΔE 7 gate) ·
`test/gold-falsify-standalone.js` (rule-6 evidence for the CSS checks) ·
`test/updates-standalone.js` (16, version ordering) ·
`test/affiliate-standalone.js` (25, link shaping) ·
`test/inventory-reconcile-standalone.js` (17, deleting a roll leaves nothing
behind — falsified by `scripts/falsify-reconcile.js`).

Live gates that need REAL hardware (run by hand, results recorded in HANDOFF):
`scripts/gate-klipper.js <printer-id>` — the v2.21 reverse proxy against a real
Fluidd/Moonraker, byte-fidelity and a JSON-RPC round trip over the proxied
WebSocket included.

Green on Windows from this clone (2026-09-09, v2.23.0, 549/0) — and verified in
the 23:00 hour specifically (2026-09-01), which is when the clock-sensitive
checks used to fail. The harness runs from local disk now, so the "~2.5 min
over SMB" figure above is the old ceiling, not the floor.

**Live gates without touching production.** `scripts/boot-4546.cmd` starts a
throwaway Hub on 4546 via `U1HUB_PORT` and leaves it running for a browser to
hit; `scripts/stop-4546.cmd` kills it **by listening port**. Since v2.19 it runs
with `U1HUB_DIR` pointing at an isolated state directory that `scripts/seed-4546.js`
fills with a copy of production's config, queue and spools — so it can be clicked
around freely, writes included, with nothing reaching the install. Prefer it to
restarting 4545: that instance is dispatching nine printers, and a restart is
the user's call, not the agent's. `scripts/restart-4545.cmd` exists for when they
do ask.

**Files on `X:` cannot be written with tmp+rename** — the share refuses
rename-over-existing, silently. `modules/dispatch.js` `save()` documents the
fallback; keep it (state is local since 2026-09-09, but a user's `U1HUB_DIR`
or gcode folder can be a share, and `X:\gcode` still is) rather than
reinventing the "atomic" pattern that cost a day of edits (`MISTAKES.md`
2026-09-01).

### Known determinism debt (rule 7)

**None as of v2.19.0.** Both outstanding items are fixed; a red harness now
means a real failure, with no "re-run and see" exception. Kept here as the
record of what the fixes were, because both patterns will recur.

1. ~~**"released job is free to be claimed against reality again"**~~ raced the
   10 s executor tick. An earlier pass tried quieting the mock before releasing,
   which narrowed the window without closing it: the Hub could still be holding
   a fleet snapshot taken while the mock said "printing", and `tick()` re-adopts
   from that snapshot, not from the mock. **Fixed in v2.19** by waiting until
   `/api/fleet` actually reports the printer idle before releasing. The
   assertion is now true by construction — no tick, whenever it lands, has
   anything to re-adopt. *Lesson: a race is closed by waiting for the observable
   state you depend on, never by sleeping longer.*
2. ~~**`run-tests.js:1401`**~~ compared against `Date.now()`. **Fixed in v2.19**
   by using the plan's own `generated_at` as the baseline — the instant the
   planner actually used. *Lesson: every time arithmetic in a test has a correct
   baseline somewhere in the response; find it rather than reaching for the
   clock.*

## Working over the bridge

Everything on this machine (this clone, and `X:\gcode` on the share) is reached
through Desktop Commander over the remote-device bridge. The clone's parent,
`C:\Users\Danny\code`, is also the session's connected folder, so
`device_stage_files` can lift a file out of the repo when you need to look at
an image or a zip in the cloud workspace. Four hard edges, all learned the
expensive way (`MISTAKES.md`):

- **60 s per-call ceiling.** Any foreground command that outlives it is lost,
  output and all. Write a `.cmd` that redirects to a log, launch it with
  `Start-Process cmd -ArgumentList '/c','<file>' -WindowStyle Hidden`, then poll
  the log. `-ArgumentList` mangles inline `^&^&` escaping — put the command in a
  file rather than fighting the quoting.
- **Never blanket-kill `node.exe`.** Desktop Commander *is* node; `taskkill /IM
  node.exe /F` takes the tool running the kill. Kill by command line or by
  listening port instead. Two `node.exe` processes with no `server.js` in their
  command lines are the bridge itself — the healthy state, not a zombie Hub.
- **`X:` cannot be granted by folder request**, and the desktop folder picker
  refuses mapped drives and UNC paths alike. Desktop Commander reaches `X:`
  directly; don't burn turns on access requests for it.
- **The Linux workspace on this device does not start.** `device_bash` is
  unavailable, so Desktop Commander's `start_process` is the shell. Redirection
  and chaining work there (unlike the old `server-win-cli`), but each call is
  still bound by the 60 s ceiling above.
