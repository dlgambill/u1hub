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
3. **Staging is the source of truth.** Never build or reason from GitHub main
   or the `C:\Users\Danny\code\u1-print-hub` clone. Staging was
   `X:\u1-print-hub`; as of 2026-08-30 it is mirrored to
   `C:\Users\Danny\code\u1-hub-staging`, because mapped network drives are
   unreachable from a Cowork session. **Two trees now exist — confirm which one
   is live before the first edit.**
4. **Version bumps are atomic.** `server.js`, `public/index.html`, and
   `package.json` change in the same pass, then `npm test`.
5. **Never commit state files.** config.json, spools.json, slots.json, auth.json,
   queue.json, printlog.json, tunnel.json, dispatch.json, slicejobs.json.
   Commit with explicit `git add` — never `git add -A`.

## Harness

`npm test` → **290 checks**, expect **290 passed, 0 failed**. A red harness
blocks everything.

Green on cloud Linux and on Windows against `X:` (2026-08-30). One known flaky
check — "released job is free to be claimed against reality again" races the
10 s executor tick; see `MISTAKES.md`. Re-run before believing it.
