# CLAUDE.md — U1 Print Hub

## Mistake log

Log mistakes in `MISTAKES.md` (what happened, root cause, prevention). Newest
first. Read it before touching an area you have broken before. When the same
failure appears 4–5 times, promote it to a hard rule below.

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
3. **Staging is the source of truth.** `X:\u1-print-hub` is where code is read,
   edited and tested. Never build or reason from GitHub main or the
   `C:\Users\Danny\code\u1-print-hub` clone — that clone exists to hold history
   and is the only place to commit. `X:\u1-print-hub\.git` is stale (last tag
   `v2.6.0`) and must never receive a commit.
   `C:\Users\Danny\code\u1-hub-staging` was a one-off mirror from the days when
   `X:` was unreachable; Desktop Commander reaches `X:` directly now, so that
   mirror is dead weight, not a second source of truth.
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

## Harness

`npm test` → **481 checks**, expect **481 passed, 0 failed**. A red harness
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

Green on Windows against `X:` (2026-09-01 12:41, v2.20.0) — and verified in the
23:00 hour specifically, which is when the clock-sensitive checks used to fail.

**Live gates without touching production.** `scripts/boot-4546.cmd` starts a
throwaway Hub on 4546 via `U1HUB_PORT` and leaves it running for a browser to
hit; `scripts/stop-4546.cmd` kills it **by listening port**. Since v2.19 it runs
with `U1HUB_DIR` pointing at an isolated state directory that `scripts/seed-4546.js`
fills with a copy of production's config, queue and spools — so it can be clicked
around freely, writes included, with nothing reaching the install. Prefer it to
restarting 4545: that instance is dispatching nine printers, and a restart is
the user's call, not the agent's. `scripts/restart-4545.cmd` exists for when they
do ask.

**State files on `X:` cannot be written with tmp+rename** — the share refuses
rename-over-existing, silently. `modules/dispatch.js` `save()` documents the
fallback; any new state writer must follow it rather than reinventing the
"atomic" pattern that cost a day of edits (`MISTAKES.md` 2026-09-01).

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

Everything reaches `X:` and this machine through Desktop Commander over the
remote-device bridge. Four hard edges, all learned the expensive way
(`MISTAKES.md`):

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
