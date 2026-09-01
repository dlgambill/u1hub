# MISTAKES.md

Running log of things that broke, why, and the rule that stops a repeat.

**How to use this file**

- Every time the agent breaks something, or Danny corrects it, append an entry.
- Newest first. Never delete entries — they are the evidence.
- Format: What happened / Root cause / Consequence / Rule.
- When the same failure shows up 4–5 times, it stops being a mistake and becomes
  a law in `CLAUDE.md`. Move the rule up; leave the entries here.
- Before touching an area, grep this file for it.

**Promoted so far** (the entries stay below as the evidence):

| Cluster | Entries | Law |
|---|---|---|
| Test depends on when it runs / what else runs | 4 incidents, 5 checks | rule 7 |
| Asserted or acted without checking first | 6 incidents | rule 8 |
| Harness green while the feature was broken | 1 incident | rule 2 — "green" is not "verified" |
| Unverified shape trusted as complete | 2 incidents | rule 6 |
| Version drift across the three files | 1 | rule 4 |
| Staging vs git clone drift | 1 | rule 3 |
| Bridge / tooling sharp edges | 5 incidents | *not a law* — reference block, "Working over the bridge" |

Bridge quirks are operating facts, not judgment failures; a rule that says
"remember these four things" is a lookup table wearing a rule's clothes.

---

## 2026-09-01 — The affiliate off switch destroyed the thing it switched off

**What happened:** The new Amazon associate feature has an on/off toggle. On an
install that had never configured it, one click of "turn off" wrote
`affiliate: { amazon: "" }` — and this module treats an explicit empty string as
"deliberately cleared", which sticks forever. Turning it back on restored
nothing, and the UI then had no button to offer because its "turn on" branch
required a stored tag. A one-way door, in a feature whose entire justification
is that it is one click to reverse.

**Root cause:** The POST handler read the RAW config block
(`ctx.cfg.affiliate`) instead of resolving it through `affiliateConf()`, which
is the function that applies the default. `cur.amazon` was `undefined`, the
handler coerced it to `""`, and persisted that.

**Why the harness missed it:** every harness case set a tag explicitly before
toggling, so the default path — the one every real first-time user takes — was
never exercised. A fixture that always supplies a value cannot test what happens
when nobody does.

**Consequence:** none in the field; caught on the throwaway instance during the
live gate, before any commit.

**Rule:** when a setting has a default, at least one test must start from
*nothing configured* and drive the full round trip — set, unset, set again — and
assert the value survives. And a handler that resolves defaults must read
through the same resolver everything else reads through; two paths to the same
setting is two chances to disagree. (Rule #2 earns its keep here: the harness
was green and the feature was still broken. "Green" is not "verified".)

---

## 2026-09-01 — Carried a stale claim forward in my own handoff

**What happened:** `HANDOFF.md` listed "mobile horizontal overflow on Match and
Dispatch — still open" as a backlog item, and I repeated it to Danny twice as
outstanding work. Measured at a real 390 px viewport, `scrollWidth ===
clientWidth` on all five tabs. It had been fixed — most likely by the v2.11
`.vtab{letter-spacing:0}` change and the v2.16 `.rscroll` wrap — and nobody had
re-checked.

**Root cause:** I wrote the claim into a document, then treated the document as
evidence. A backlog is a list of things *believed* to be true when written; it
decays like any other cache.

**Consequence:** nearly "fixed" something that was not broken, which would have
meant a change with no verifiable effect sitting in a release diff.

**Rule:** re-measure a backlog item before working it, and again before quoting
it as outstanding. Notes are a starting point for verification, never a
substitute for it. Same rule-8 family, third form: after "didn't check", "read
one file and generalised", now "believed my own note".
*(Also worth keeping: the way this was measured. The window would not resize, so
the page was loaded into a 390 px `<iframe>` — which gets its own layout
viewport, so `@media` queries evaluate against it. That is a reliable way to
test a mobile layout from a desktop browser.)*

---

## 2026-09-01 — Audited a stylesheet without reading the stylesheet

**What happened:** Asked for a "sleeker UI" pass, I audited `public/index.html`,
counted the inline `<style>` block, and reported to Danny that the Hub had **0
custom easing curves, 5 transitions, 1 `:focus-visible`, and no display font** —
framed as "across all 3,184 lines." I proposed a whole new override layer,
`hub-ui.css`, and wrote 200 lines of it.

`public/gold.css` had been sitting in the repo since 2026-08-30. 150 lines. It
already had a self-hosted Outfit variable font (with the exact "LAN installs
have no internet" reasoning I re-derived as though it were novel),
`--ease:cubic-bezier(.22,1,.36,1)`, `--dur`, focus-visible rings, elevation,
atmosphere, and a header comment banning entry animations on SSE content. I had
shipped v2.16.0 through that file without ever opening it.

**Root cause:** I read the file I was told about and stopped. `index.html` links
`gold.css` on line 535 — one line below the `</style>` I had just finished
counting. The grep counts were scoped to one file and reported as if scoped to
the app. Every number was literally true and the conclusion drawn from them was
false.

**Consequence:** A confidently wrong audit delivered to Danny, a proposed
second override layer that would have fought the first over `.pcard:hover`, and
200 lines of work deleted. Caught only because wiring the `<link>` meant reading
the `<head>`, where the existing `<link>` was.

**Rule:** Rule #1 says read every file you are about to change. Extend it: read
every file the file you are about to change *loads*. A stylesheet's behaviour is
the whole cascade, not one block of it. Before reporting an absence — "there is
no X in this project" — resolve every `<link>`, `<script src>`, `require` and
`import` on the path first. An absence claim is a whole-project claim and needs
whole-project evidence. This is a rule-8 repeat (asserted without checking),
now 5 incidents.

---

## 2026-09-01 — The bridge strips `$` from PowerShell commands

**What happened:** Roughly eight `start_process` calls failed in a row with
`The term '.Groups[1].Value' is not recognized`, `You must provide a value
expression following the '+' operator`, and `=X:\path is not recognized`.

**Root cause:** Desktop Commander's `start_process` drops `$` characters before
handing the string to PowerShell. `$f='X:\...'` arrives as `='X:\...'`;
`$_.Groups[1]` arrives as `.Groups[1]`. Nothing is escaped or quoted wrong — the
character is simply gone.

**Consequence:** Wasted calls against a 60 s ceiling, and one command that
silently returned partial output rather than erroring.

**Rule:** Write `$`-free PowerShell over the bridge. No variables, no `$_`, no
`$PSItem` — pipe into `Select-Object`/`Format-Table` with `-Property` instead,
or use `Select-String` directly. When a command genuinely needs variables, write
a `.ps1` to `scripts\` with `write_file` and invoke the file. Also note the
shell is **PowerShell, not cmd**: `&&` is a parse error, use `;`.

---

## 2026-09-01 — "Atomic write" silently ate 17 hours of Dispatch edits

**What happened:** Danny reported that jobs he had removed from Dispatch kept
coming back. `dispatch.json` had a mtime of **07:37 the previous morning** and
still held 41 jobs, while a `dispatch.json.tmp` sat beside it, written minutes
earlier, holding the real 35-job state. Every removal, and every completion the
executor recorded through the day, existed only in memory and in that tmp.

**Root cause:** `save()` did the textbook atomic write —
`writeFileSync(tmp)` then `renameSync(tmp, FILE)`. Staging is an SMB share
(`X:` → `\\192.168.12.81\share`), and Windows rename-over-an-existing-file
across SMB does not reliably replace the destination. `renameSync` threw on
every save. The executor's `tick().catch(() => {})` swallowed it every 10 s, and
the API handlers surfaced nothing, so the UI cheerfully showed the job gone and
the next reload brought it back.

`resources.json` and `spools.json` were untouched by this because they write
straight to the file. Dispatch was the only writer using tmp-then-rename, and it
is exactly the pattern this filesystem rejects.

**Consequence:** A full day of scheduling decisions lost from disk, discovered by
the user rather than by the software. Two things were wrong at once: the write
failed, and nothing said so.

**Rule:** Two, and the second matters more.
(1) **An atomic write is a property of the filesystem, not of the code.** On this
project, `save()` tries rename and falls back to a direct write when the share
refuses, logging the fallback once. Anywhere else that grows a tmp+rename must do
the same or it inherits this bug.
(2) **A swallowed error on a repeating timer is a silent-failure generator.**
`catch(() => {})` inside a 10 s interval will hide a permanent fault forever.
Log it — rate-limited if need be — because the alternative is finding out from
the person whose data it was. The harness now pins the invariant rather than the
mechanism: a removal must reach the disk, no `.tmp` may be stranded, and it must
still be gone after a restart.

---

## 2026-08-31 — A colour mapped to a forgotten spool went quietly "unassigned"

**What happened:** Danny mapped `#000000` to a Bambu Black spool and set 600 g at
$25. He later swapped it for an Overture Black — forgetting the old spool and
binding the new one. The Resources row went back to reading `UNASSIGNED`, its
grams and price gone, with nothing anywhere explaining why. Found by comparing a
screenshot against `resources.json`, not by any warning the UI produced.

**Root cause:** `matchSpool` looked up the mapped id, got `undefined` because the
spool no longer existed, and **fell through to nearest-match** — which at the
dE 7 ceiling matched nothing. A deliberate human decision was discarded and
rendered identically to a colour that had never been mapped at all. The
inventory row keyed to the dead id became invisible at the same time.

**Consequence:** Small in data terms, large in trust: the one row he had
configured was the one that appeared to lose his work.

**Rule:** **A dangling reference is a state, not an absence.** When a stored id
no longer resolves, say so — never fall through to the heuristic the id existed
to override. Orphaned rows keep their grams, report `orphan` with the missing id
named, and are counted separately from never-mapped ones; orphaned inventory is
reported rather than left to rot in the file.

---

## 2026-08-31 — The wall-clock fix removed the clock from the test, not the plan

**What happened:** The 23:02 run went red on two MOD5 checks — "override cleared
→ planning returns to now" and "no job waits on a busy printer while another
printer is free". Neither code path had been touched; the work that session was
the Resource Monitor and a Spools-tab button.

**Root cause:** Two variants of the same defect.

`run-tests.js:991` was a bare `est_start < Date.now() + 10 * 60000` — the exact
thing CLAUDE.md forbids, sitting in the file the whole time. With today
re-enabled but ~57 minutes of window left, a 62-minute job correctly plans for
00:00, so "returns to now" cannot hold in the last hour of any day.

The spread check is the more interesting one: it was **already fixed** on
2026-08-30, when `Date.now()` was replaced by `earliestPlanned`. That removed
the wall clock from the *comparison* but not from the *plan*. Near a closing
window some copies fit today and the rest move to 00:00 — so a lane whose only
slot is tomorrow reads as "idle at 23:28" and the check called it waste. The
lane was not available; starting there would have overrun the window.

**Consequence:** A red harness blocking a ship, on a defect that had been
diagnosed and half-fixed the day before. The first fix was verified by the run
passing, which at 14:00 proves nothing about 23:02.

**Rule:** Two things, both now in CLAUDE.md.
(1) A lane, slot or resource is only a genuine alternative if it is free for the
whole SPAN of the work, never merely at the instant it starts —
`idleThrough(p, est_start, est_end)`, not `busyAt(p, est_start - 1)`.
(2) When fixing a time-dependent test, ask what the assertion means at 23:59,
not whether it passes now. Both fixes here were verified by falsification (flip
the expectation, watch exactly those checks go red, revert) and by re-running
inside the 23:00 hour that had just failed — 356/0 at 23:15.

---

## 2026-08-31 — Handed Danny a task this file already documents how to do

**What happened:** With the v2.16 Resource Monitor built and needing its ship
gate, I told Danny "`npm test` takes ~2.5 min over SMB and the bridge dies at
60 s — that one's yours." He replied that he was not in a position to run it.

**Root cause:** The workaround is four entries down in this very file
("Desktop Commander works; the bridge times out at 60 s": write a `.cmd` that
redirects to a log, `Start-Process -WindowStyle Hidden`, poll the log). I had
read MISTAKES.md at the start of the session, applied its `X:`-is-truth and
never-blanket-kill-node rules all the way through, and then failed to apply the
one entry that was about the exact obstacle in front of me. Reading the file is
not the same as consulting it at the moment of the decision.

**Consequence:** A round trip spent handing back work that took three polls to
do, at the point where the feature was otherwise finished.

**Rule:** Before declaring anything blocked or "yours to run", grep this file
for the obstacle. The entries are not history, they are the workarounds. A
constraint that appears here has already been solved once.

---

## 2026-08-31 — 950 lines shipped with the harness count unchanged

**What happened:** The Resource Monitor (parser extension, `modules/resources.js`,
`public/modules/resources-ui.js`, Spools-tab inventory) was built and verified
against real gcode by three standalone scripts. `npm test` stayed at **323
passed** through the whole build — the same number as before a line was written.
I reported that as "green" more than once before naming it as a gap.

**Root cause:** Standalone harnesses feel like coverage. They test better inputs
than fixtures do (real 54 MB Orca files, the actual shelf), but they only run
when a human types the command, and `npm test` is what gates a ship. An
unchanged check count after a large feature is the signal, and it was visible
from the first run.

**Consequence:** A window where a rename in `parser.js` would have silently
broken the Resources tab with a green harness. Closed at 355 checks.

**Rule:** A feature is not covered until the harness COUNT moves. Treat an
unchanged total after new code as a red flag in its own right, and say so before
calling the run green. Standalone scripts are a supplement to `npm test`, never
a substitute — see hard rule #6 in CLAUDE.md for the other half of this
(a check must be shown to fail before it counts).

---

## 2026-08-30 — SPREAD check asserted against the wall clock, went red at 23:50

**What happened:** The v2.15 harness run at 23:50 failed on "no job waits on a
busy printer while another printer is free at that moment", with
`{"job":"single.gcode","on":"SV-mock","at":"00:00","freeLane":0}`. Nothing in
that code path had been touched.

**Root cause:** the check treated *"starts more than 60 s after `Date.now()`"*
as evidence a job was queued behind something. With an attended window closing
at 23:59, a 90-minute job does not fit in what is left of today, so `plan()`
correctly defers the whole plan to 00:00 rather than starting a print it knows
will overrun the block. Every job then starts "later than now" while both lanes
are idle — the check calls that waste. It is not waste; it is the documented
fitting rule. The test was latently broken for roughly one hour out of every
24, and simply had not been run in that hour before.

**Consequence:** a red harness that blocks a ship, on a defect in the test, at
the exact hour when the person reading it is least likely to be patient.

**Rule:** **Never assert against `Date.now()` in a scheduler test.** Compare to
something the plan itself produced — here, the earliest start in the plan, which
makes the check mean what it always meant ("this job is queued behind
something") without borrowing the wall clock. Same family as the 10 s executor
tick: if the assertion's truth depends on when you run it, the assertion is
wrong. Every deadline test added in v2.13 derives its times from observed slots
for this reason; this older check predated the lesson.

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
