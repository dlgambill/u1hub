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
   queue.json, printlog.json, tunnel.json, dispatch.json, slicejobs.json.
   Commit with explicit `git add` — never `git add -A`.

## Harness

`npm test` → **307 checks**, expect **307 passed, 0 failed**. A red harness
blocks everything.

Green on Windows against `X:` (2026-08-30, v2.13.0). One known flaky
check — "released job is free to be claimed against reality again" races the
10 s executor tick; see `MISTAKES.md`. Re-run before believing it.
