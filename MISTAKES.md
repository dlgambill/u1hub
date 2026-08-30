# MISTAKES.md

Running log of things that broke, why, and the rule that stops a repeat.

**How to use this file**

- Every time the agent breaks something, or Danny corrects it, append an entry.
- Newest first. Never delete entries — they are the evidence.
- Format: What happened / Root cause / Consequence / Rule.
- When the same failure shows up 4–5 times, it stops being a mistake and becomes
  a law in `CLAUDE.md`. Move the rule up; leave the entries here.
- Before touching an area, grep this file for it.

---

## 2026-08-30 — `taskkill /IM node.exe /F` kills the Desktop Commander bridge

**What happened:** Ran the handoff's own start-of-session step 1,
`taskkill /IM node.exe /F`, through Desktop Commander. The call returned
"Connection closed", and so did the next two.

**Root cause:** Desktop Commander *is* node. Two processes —
`npx-cli.js @wonderwhy-er/desktop-commander` and the server's `dist/index.js` —
both `node.exe`. A blanket kill takes the tool executing the kill. It restarts
on its own within a few seconds, so the damage is confusion rather than a dead
session, but two of those three lost calls were spent re-diagnosing a bridge
that was never broken.

**Consequence:** ~3 wasted turns at the very start of a session, every session,
following the documented checklist.

**Rule:** Never blanket-kill `node.exe` from inside a node-hosted tool. To clear
a zombie Hub, kill by command line, not by image name:

```
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Two `node.exe` processes at session start with no `server.js` in their command
lines are the bridge itself — that is the healthy state, not a zombie Hub.

---

## 2026-08-30 — Mapped drive `X:\` cannot be granted by folder request

**What happened:** Requested access to `X:\u1-print-hub` via the folder-access
request; refused. Mapped network drives (UNC-backed) are not grantable that way.

**Root cause:** `X:` resolves to `\\192.168.12.81\share\...`, which falls outside
the grantable-path pattern. Same underlying reason the filesystem MCP fails on
`X:\` subdirectories.

**Consequence:** Session stalled until Danny connected the folder manually.

**Rule:** For `X:\` paths, ask Danny to use the **Add folder** picker in the
desktop app up front. Do not burn turns on folder-access requests for `X:`.

**Follow-on (same session):** the picker does not accept mapped drives either,
and UNC paths (`\\192.168.12.81\share`) are refused at the tool layer. The
Linux workspace on ichabod failed to start — four attempts, including after a
full Claude Desktop restart — so there is no shell on the machine. Danny's own
MCP servers (`server-win-cli`, filesystem) are not proxied into a Cowork
session either, so the handoff's documented workarounds do not apply here.
Computer use grants terminals **click-only** tier — visible and clickable,
never typeable. **Net rule: anything that must run as a shell
command on ichabod is Danny's to paste. Ask once, with the exact command,
rather than hunting for a way around it.**

---

## 2026-08-30 — Flaky harness check: "released job is free to be claimed again"

**What happened:** Danny's Windows run reported **288 passed, 2 failed**, the
extra failure being `released job is free to be claimed against reality again`
→ `{"on":0,"s":"printing"}`. The cloud run of the same commit was green. Re-run
on the same machine, same files: **289 passed, 1 failed** — it did not
reproduce.

**Root cause:** a race, not a regression. The test leaves
`mockU1.state.printState = "printing"` with `filename = "single.gcode"`, then
calls `/jobs/release` and immediately reads the job back. The executor's
background `tick()` runs every `EXEC_TICK_MS` (10 s) and legitimately re-adopts
any printing file whose job has `printing_on == null` — which is exactly what
release just produced. If a tick lands in that window, the job is re-claimed
before the assertion reads it.

**Consequence:** an intermittent red harness that blocks a ship for no reason,
and ~20 minutes spent establishing that a real fix had not broken anything.

**Rule:** A test that races a background timer is a broken test. Either quiet
the world first (set the mock to `standby` before asserting on a release) or
drive the executor deterministically via `/api/dispatch/tick`. Never assert
across a live 10 s interval. **A failure that does not reproduce is a defect in
its own right — log it, don't shrug it off.**

---

## 2026-08-30 — Desktop Commander works; the bridge times out at 60 s

**What happened:** Long commands through Desktop Commander (`npm test`, ~2.5 min
on `X:` over SMB) died with "Device 'ichabod' did not respond within 60s", and
`list_sessions` showed nothing afterwards — the process went with the call.

**Root cause:** the remote-device bridge has a hard ~60 s per-call ceiling. Any
foreground command that outlives it is lost, output and all.

**Rule:** Never run a long job in the foreground over the bridge. Write a `.cmd`
that redirects to a log, launch it with
`Start-Process cmd -ArgumentList '/c','<file>' -WindowStyle Hidden`, then poll
the log with `read_file` or `Select-String`. Also: `-ArgumentList` mangles
inline `^&^&` escaping — put the command in a file instead of fighting the
quoting.

---

## 2026-08-30 — Told Danny twice that installing an MCP server wouldn't help

**What happened:** Asked whether DesktopCommanderMCP would fix the missing
shell, I argued no — "your `win-cli` and filesystem servers should already be
proxying into this session and aren't, so a third server in the same file
changes nothing." When the config was finally read, it had **no `mcpServers`
block at all**. The premise was false and the conclusion was worthless.

**Root cause:** Built an argument on an unread file. "The servers are declared
but not proxied" was never observed — it was inferred from their absence in the
tool list, which is equally consistent with "nothing is declared." Rule #1 says
read before writing; the same applies to reasoning.

**Consequence:** Danny was steered away from a fix that may well work, twice,
with confident-sounding reasoning behind it.

**Rule:** Do not build an argument on the contents of a file that has not been
read. If it cannot be read, say "I don't know what's in it" and name what would
settle it — never substitute an inference and present it as the reason.

---

## 2026-08-30 — Harness red: test regex asserts ASCII `x`, code emits `×`

**What happened:** `npm test` on a clean staging tree returns **286 passed, 1
failed**, not the 287/0 the handoff claims. The failing check is
"copies cloned in pipeline; settings echoed back APPLIED from the gcode tail".

**Root cause:** `modules/slicing.js:293` builds the message
`"cloned " + n + " instance(s) ×" + copies` using `×` (U+00D7 MULTIPLICATION
SIGN). `test/run-tests.js:1332` asserts `/cloned .*x3/` — ASCII lowercase `x`.
The regex can never match. Deterministic, platform-independent; verified by
running the regex against the literal string.

**Consequence:** The documented ship gate ("287 passed, 0 failed") has been
unmeetable since the message string changed. A red harness blocks everything,
so this silently gates v2.12.

**Rule:** Never assert on a user-facing display string. Test the structured
field (`sj.copies === 3`) and let the prose be prose. When an assertion must
touch text, match a stable ASCII substring, never a typographic character.

---

## 2026-08-30 — Copied 30+ GB of gcode onto the C: drive

**What happened:** Told Danny to relocate staging with
`robocopy X:\u1-print-hub ... /E`. `/E` took the whole tree, including
`gcode\` — ~220 sliced files, most 100–350 MB, well over 30 GB duplicated onto
his system drive. He had to delete them by hand.

**Root cause:** Wrote the command for completeness without checking what the
tree actually contained. `device_list_dir` on `gcode\` would have shown the
sizes in one call, before the command was sent rather than after.

**Consequence:** 30+ GB of avoidable disk churn, a slow copy, and a cleanup
step Danny had to run because nothing here can delete files.

**Rule:** Before handing over any recursive copy command, list the source tree
and check directory sizes. Exclude bulk data by default:
`/XD node_modules gcode 3mf`. A copy is for *code* unless the task says
otherwise.

---

## 2026-08-30 — `overflow-x: hidden` on html/body broke Cloudflare Access

**What happened:** Added `html, body { overflow-x: hidden }` to `gold.css` to fix
the mobile nav tab overflow. The Cloudflare Access tunnel broke. Danny reverted.

**Root cause:** Wrong layer. The tabs overflow because the Outfit font plus
`letter-spacing: 0.005em` in `gold.css` makes tab text wider than system-font
measurements — the fix belongs on `.vtab`, not on the document root.

**Consequence:** Tunnel breakage on a live-facing surface; revert + lost session.

**Rule:** Never set global `html`/`body` overflow or positioning to fix a local
component. Fix the element that is actually too wide. Any change to `gold.css`
that touches document-root selectors gets tunnel-tested before it stays.

---

## 2026-08-27 — Staging and git repo drifted apart

**What happened:** `C:\Users\Danny\code\u1-print-hub` (git) was missing
`modules/slicing.js`, which exists in `X:\u1-print-hub` (staging). Reading the
git copy would have produced a fix against stale code.

**Root cause:** Staging is intentionally uncommitted; nothing enforces parity, so
"the repo" and "the build" are two different trees.

**Consequence:** Near-miss — almost edited files that are not what runs.

**Rule:** `X:\u1-print-hub` is the only source of truth for reading and editing.
Never build or reason from GitHub main or the `C:` clone. Verify which tree you
are in before the first edit.

---

## 2026-08-09 — FS Mixer parser silently dropped `m2` pair mixes

**What happened:** The gcode parser only decoded list (`m0`) definitions. Pair
(`m2`) mixes in sliced gcode were missing from the Hub's FS preview — with no
error, no warning.

**Root cause:** Decoder written against one observed shape and assumed complete.
No round-trip test against the other hardware-verified shape.

**Consequence:** Wrong preview shown as if correct. Silent wrongness, found late.

**Rule:** A decoder gets a byte-exact emit↔decode round-trip test for **every**
shape hardware has produced, before it is trusted. Unverified shapes (4-component
mixes) are not emitted at all — Rule #1.

---

## 2026-08-09 — Version string drift across files

**What happened:** Version appeared inconsistently across `server.js`,
`public/index.html`, and `package.json` during a bump.

**Root cause:** Version lives in three places and was edited one at a time.

**Consequence:** Harness now asserts a single version everywhere; a partial bump
is a red test and a blocked ship.

**Rule:** Bump `server.js`, `public/index.html`, and `package.json` in the same
edit pass, then run `npm test` before anything else. Never a partial bump.

---

## 2026-08-30 — Shell MCP fails on redirection and chaining

**What happened:** Attempts to write files over SMB using shell redirection (`>`)
and chained commands (`&&`) failed repeatedly.

**Root cause:** `@simonb97/server-win-cli` handles simple single commands only;
redirection, chaining, and running node/python over SMB are unsupported.

**Consequence:** Repeated failed tool calls burning turns and context.

**Rule:** Write files with the filesystem tool to a grantable location, then
`copy` into place with a single shell command. For small targeted patches, one
Python one-liner per patch. Never `>` and never `&&`.
