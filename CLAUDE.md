# CLAUDE.md — U1 Print Hub

## Mistake log

Log mistakes in `MISTAKES.md` (what happened, root cause, prevention). Newest
first. Read it before touching an area you have broken before. When the same
failure appears 4–5 times, promote it to a hard rule below.

## Hard rules

1. **Rule #1 — read before writing.** Read every file you are about to change,
   in full, before the first edit. No patching from memory or from a grep hit.
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
   green while its check count sat unchanged.

## Harness

`npm test` → **371 checks**, expect **371 passed, 0 failed**. A red harness
blocks everything.

Takes ~2.5 min over SMB. Run it with `scripts/run-harness.cmd` and poll
`scripts/harness.log` — see **Working over the bridge** below for why.
`node scripts/check-index-js.js` is the companion check for
`public/index.html`: `node --check` only covers `.js`, so a typo in the page's
own 2,400-line inline script would otherwise ship silently.

Green on Windows against `X:` (2026-09-01 00:36, v2.16.0) — and verified in the
23:00 hour specifically, which is when the clock-sensitive checks used to fail.

**State files on `X:` cannot be written with tmp+rename** — the share refuses
rename-over-existing, silently. `modules/dispatch.js` `save()` documents the
fallback; any new state writer must follow it rather than reinventing the
"atomic" pattern that cost a day of edits (`MISTAKES.md` 2026-09-01).

### Known determinism debt (rule 7)

Two items. Both are **defects**, not quirks — rule 7 is explicit that "re-run
before believing it" is a bug report.

1. **"released job is free to be claimed against reality again"** races the 10 s
   executor tick: the test leaves the mock printing, calls `/jobs/release`, and
   reads the job back, while `tick()` legitimately re-adopts it in that window.
   Fix by quieting the world first (set the mock to `standby` before asserting)
   or driving the executor through `/api/dispatch/tick`. Until then it can go
   red on a clean tree — which is exactly the exception rule 7 forbids.
2. **`run-tests.js:1401`** still compares against `Date.now()` ("with today and
   tomorrow closed, the copy waits for the next attended day"). The bound is
   loose enough to hold at every hour of a normal day — the gap is always
   24–48 h against a 23.5 h threshold — but a spring-forward day is 23 hours
   long, so at 23:59 it would go red once a year.

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
