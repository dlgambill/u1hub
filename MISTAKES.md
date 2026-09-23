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
| Test depends on when it runs / what else runs | 5 incidents, 6 checks | rule 7 - and read the reason the system recorded, not a proxy from times |
| Asserted or acted without checking first | 12 incidents | rule 8 |
| Harness green while the feature was broken | 4 incidents | rule 2 — "green" is not "verified"; the live gate for a button is the click |
| Unverified shape trusted as complete | 3 incidents | rule 6 |
| Shipped onto one surface, not every surface that draws the thing | 4 incidents | *approaching a law* — check every tab that renders it before calling it done; the phone is a surface, 390px frame, scrollWidth <= innerWidth |
| Version drift across the three files | 1 | rule 4 |
| Staging vs git clone drift | 2 incidents | rule 3 |
| Claimed done without opening the artifact | 1 | *watch this one* — a summary is not evidence |
| Bridge / tooling sharp edges | 6 incidents | *not a law* — reference block, "Working over the bridge" |

Bridge quirks are operating facts, not judgment failures; a rule that says
"remember these four things" is a lookup table wearing a rule's clothes.

---

## 2026-09-23 - 2.29 shipped a phone that cut every printer card off at the right edge

**What happened:** Danny, from his phone: "since we made changes
yesterday, the printer cards have been getting cut off on mobile. I can't
pinch them to fit the screen either." The 2.29 price readout on the job
card was a `white-space:nowrap` span ~80 characters long. `.main` is a
grid item with the default `min-width:auto`, so its track grew to the
span (~700px on a 390px phone); the phone layout's `.shell{overflow-x:
clip}` then cut the excess off with nothing to scroll or zoom into. Every
card below the job card - the whole fleet - lost its right third.

**Root cause:** two releases (2.29.0, 2.30.0) verified on 4546 in a
desktop Chrome and never at a phone width, and I had written in the 2.28.1
note that 390px was "the first thing to tell me" - then did not check it
myself on the next two. Same cluster as "shipped onto one surface, not
every surface that draws the thing": the phone is a surface.

**Consequence:** the dashboard unusable on a phone for about a day, which
is where Danny reads it from the market.

**Rule:** the live gate for anything on the dashboard includes a 390px
frame, and the check is one number: `document.documentElement.scrollWidth
<= innerWidth`. The window-resize tool did not take on a maximized Chrome;
a same-origin 390px iframe injected into the page did, and is now the
way. And `min-width:0` on grid/flex items that hold arbitrary content is
not optional - the shell has it now (gold.css), so this class of overflow
cannot resize the page again. Cluster count for "one surface, not every
surface" goes to 4.

---

## 2026-09-22 - The planner "waste" check went red at 22:49, third time at a window edge

**What happened:** "no job waits on a busy printer while another is free
for its whole run" failed on a run that started at 22:45 local. A job too
long for what was left of the attended window landed at 00:00 on lane 0;
a short job that still fit today ran on lane 1 and was done by midnight; so
lane 1 was "idle through" the long job's span and the check called that
waste. Two earlier passes (2026-08-30 at 23:50, 2026-08-31 at 23:02) had
removed `Date.now()` from the comparison and then required the free lane to
be free for the whole span. Neither asked what the PLAN was doing.

**Root cause:** the check kept deriving "waiting" from geometry (start
times and idle lanes), and the only question it ever meant to ask - could
the farm have started this copy sooner? - was not answered anywhere in the
plan. My first fix read `slot.delay` (why the copy waits on ITS lane) and
went red five minutes later: that block is per chosen lane, and a copy can
show `queue: 62` on lane 0 while no other lane could have started it
earlier either. Wrong field, same reflex.

**Consequence:** two red runs on release night, no bad code behind either.
Not waved through: the planner now writes `earliest_any` into every slot
(the earliest start any lane offered for that copy, windows and in-flight
prints included) and the check compares against that. Three copies
stacked on one idle-neighbored lane still trip it by hours; a copy the
window deferred does not, because its earliest_any moved with it.

**Rule:** rule 7, applied one level deeper. When a check wants to know why
something happened, have the system record the answer and read it; do not
reconstruct it from times, and do not grab the nearest field that sounds
right (`delay` sounded right). If the response has no such field, add the
field to the response before writing the assertion.

---

## 2026-09-22 - The 2.25 AI pre-flight button shipped dead, behind a green harness

**What happened:** `public/modules/advisor-ui.js` read the selected file as
`window.SELECTED` and the fleet as `window.FLEET`. Both are declared with a
top-level `let` in `app.js`, and a `let` binding is not a window property,
so both reads were `undefined`. `openPanel()` began with
`if (!window.SELECTED) return;` - the click did nothing, silently, from
2.25.0 through 2.27.1. Found on 2026-09-22 while wiring the Models tab's
✦ Settings button to the same state.

**Root cause:** the harness "verified" the client with a regex over the
source (`/advgo/.test(source)`), and the live gate for 2.25 exercised the
Settings block and the server routes, not a click on the job card. Rule 2
says a feature is done when its live gate has passed; the gate I ran did
not include the one interaction the feature exists for.

**Consequence:** three releases whose headline feature could not be
started from the page. The routes worked (the harness proved that), so
anyone poking the API got answers; anyone pressing the button got nothing.

**Rule:** a client feature's live gate is the click. For every button a
release adds, the gate is: click it on 4546 in a real browser and see the
panel change, not `grep` for its id. And a client module that reads core
state gets it through an explicit surface (`app.js` now defines read-only
getters for SELECTED, MAP, FLEET, MAPSEL, FILES on `window`), never by
assuming a global exists - `typeof window.X === "undefined"` is a check
that costs one line.

---

## 2026-09-22 - Reasoned for two weeks about a two-tree split retired two weeks ago

**What happened:** Asked to analyze this file, I read it and `CLAUDE.md` on
2026-09-08 and reported that six entries sat only on the `C:` clone and would
be destroyed by "the next stage" from `X:`. Over the next two weeks I
re-measured three times, each time found `C:` ahead of `X:`, each time called
it drift, and each time "fixed" it by copying `C:` over `X:`. I then offered to
build a guard for the staging step.

There is no staging step. Danny retired the `X:\u1-print-hub` copy on
2026-09-09 - commit `6036813`, "One tree: the Hub is edited, run and committed
from this clone; X: staging retired" - one day after I read `CLAUDE.md`.
`scripts/sync-to-clone.js` and `scripts/drift-scan.js` have been stubs saying
so ever since, and the rewritten `CLAUDE.md` states plainly that a surviving
`X:\u1-print-hub` "is dead weight waiting for Danny to delete it - never read
from it." I found this only when I went to write the guard and opened the
script that was supposed to need it.

**Root cause:** I read `CLAUDE.md` once, on day one, then treated my own
summary of it as the state of the machine for two more weeks and two more
sessions. Every later turn re-measured the *files* scrupulously - line counts,
`Compare-Object`, mtimes, subset proofs - and never re-read the document that
told me what those files meant. Precision about the data made the wrong frame
feel verified. The "drift" was never drift: `C:` was ahead because `C:` is
where the work happens, which is the normal and only state.

**Consequence:** Three sessions writing into a directory Danny had abandoned,
and two confident reports describing a live data-loss risk that did not exist.
No damage to the live tree - every copy ran `C:` to `X:`, never the reverse, so
the clone was never fed stale content - and the one piece of real work (moving
six misfiled entries to `MISTAKES-shared.md`) stands on its own. But he was
told a false story twice, in detail, with measurements attached.

**Rule:** Re-read `CLAUDE.md` at the start of every session and after any
break, not once per thread. An instruction file is state, and state that is
days old must be re-read exactly like a git ref or a live table - this is rule
8 applied to the document that defines the rules. Specifically: **before
building or guarding a mechanism, open the thing that implements it.** One
read of `scripts/sync-to-clone.js` would have ended this on day one; what
finally ended it was going to write code and looking first. And when a "drift"
recurs three times while nothing else on the machine reacts to it, suspect the
frame before the facts.

---

## 2026-09-21 - process.exit() right after fetch() crashes Node on Windows

**What happened:** Building the live-hardware gate for the new timelapse
module (`scripts/gate-timelapse.js`), the script printed "4 passed, 0
failed" against a real printer, then crashed: `Assertion failed:
!(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`, and
the process exited with code -1073740791 - a native crash, not a clean
`process.exit(1)`. Every check had actually passed; a caller that only
checked the exit code would have been told the opposite.

**Root cause:** The script used the global `fetch()` (undici) and called
`process.exit(fail ? 1 : 0)` immediately after its last `await`. Undici
keeps a keep-alive socket/timer handle open after a request resolves;
forcing the process to exit while that handle is still mid-teardown hits a
libuv assertion on Windows. `scripts/gate-klipper.js` never hit this
because it uses raw `http`/`net` sockets, not `fetch`, so its own
`process.exit()` at the end was never at risk - but `fetch()` is the newer,
more obvious choice for anything hitting a printer's REST API, and nothing
about the crash pointed at the real cause (the script LOOKED like it
worked, then Node itself fell over).

**Consequence:** Caught before it shipped only because the gate was run by
hand (rule #2) rather than trusted on the strength of the code. Would
otherwise have shipped a gate script whose exit code lied about its own
result.

**Rule:** Any new script that mixes `fetch()` with an explicit
`process.exit()` needs that exit to happen via `process.exitCode = ...`
(no forced exit - let the event loop drain) instead, on Windows
specifically. One incident so far - watch for a repeat before promoting
this further.

---

## 2026-09-14 - Three synchronous reads the speed release missed, found by a slow share

**What happened:** Danny's phone showed an empty dashboard and "server has
no version" over the tunnel. The Hub was up; access.log showed every
request from every client taking 45-64 s for about a minute, right after a
198 MB gcode landed in X:\gcode. `/api/map` read a 3 MB tail with
`fs.readSync`, `paletteForFile` did the same for Match and the print-time
color check, and `fileContentHash` read 2 MB the same way. The share was
crawling; each sync read held the event loop for the length of the read,
and everything else queued behind it.

**Root cause:** v2.23 ("the speed release") moved the library walk, the
printer-file listing and thumbnails off the loop and declared victory. It
never enumerated the remaining `readSync`/`readFileSync` calls that touch
the gcode share on a request path. A sync read of a network file is a
stall of unbounded length, and the harness cannot see it because the
harness's "share" is a local temp folder.

**Consequence:** One bad minute of NAS made the whole farm's dashboard
unusable from every device. It self-healed, which is why it had never been
reported.

**Rule:** No synchronous filesystem call may touch a file under the gcode
folder (or any configured share) from inside a request handler or a timer.
`grep -n "readSync\|readFileSync\|statSync\|openSync" core modules` and
justify every hit that takes a library path: it is either a cache hit
after an async warm, or it is a bug. Still open after this fix:
`resources.js readEnds` (576 KB, Dispatch rollup) and `modules.js
fileInfoForModules` (256 KB head) - small, but the rule says they go too.

---

## 2026-09-11 - Four releases of module settings that one Save in Settings would erase

**What happened:** While wiring the advisor's key into `config.json` I read
`POST /api/config` (core/settings.js) to see how the Settings form saves, and
found it builds the file from scratch: gcodeFolder, port, types, printers,
tip, features. Every other top-level key is dropped. `updates` (2.18),
`slicing` (2.12), `spoolman` and `notify` (2.24) all write their own slice
through `ctx.saveConfig()`, so any of them set before a person pressed Save
on the printer list was gone after it. No harness check saved the form and
read a module's settings back; every module tested its own route in
isolation, against a Hub that never touched the form.

**Root cause:** Two writers to one file with two different pictures of what
the file contains. The form's route predates modules owning config, and when
modules started writing there (2.12) nobody re-read the older writer.

**Consequence:** Four releases in the field where an ntfy topic or a
Spoolman address could vanish the next time someone added a printer, with
nothing in the log. Caught by reading, not by a report, which is luck.

**Rule:** When a second writer is added to a file, read every existing
writer of that file before shipping, and add a check that exercises BOTH
writers in sequence. Rule-6 family (an unverified shape trusted as complete):
the shape here was "what config.json holds", and the form's idea of it was
five keys old.

---

## 2026-09-08 — Shipped a feature the server had and the phone could not see, because of a cache I had added a week earlier

**What happened:** Danny asked why U2 was paused. The reason was in
`print_stats.exception` (Snapmaker's fork), which the Hub never read. I wired
it through the fleet shape and the card, added five harness checks against the
exact object U2 reported, restarted production, told him the card would show
it. He opened a fresh tab: no line. The server's own `/api/fleet` for U2 said
"detect filament tangled! (extruder 0) · code 38" the whole time.

**Root cause:** During the v2.23 speed work I made `app.js` and the tab scripts
cacheable for a year, keyed on `?v=<VERSION>`. Right for releases: the number
changes, the URL changes. Wrong for a test week: the number stayed 2.23.0 for
six days of edits, so every phone that had loaded the page once kept the old
`app.js` and drew the card the old way. The harness reads `app.js` from disk,
so it was green against code no browser was running.

**Consequence:** A confident "reload and you'll see it" that was false, and
had he not sent the screenshot, every client-side change of the test week
(spool glyph, spelling, the pause line) would have reached him only at the
next version bump, while I reported each as done.

**Rule:** A cache key must change whenever the cached thing changes, not
whenever a person decides to call it a release. The stamp is now
`<version>-<content hash of the stamped assets>`, computed at boot, so a
restart after any client edit moves every asset URL together. More generally:
when a change is client-side, the proof is a screenshot from a device that had
the old page, never a passing check that reads the file from disk. Rule-2
family, third incident; and the file this feature touched (`core/app.js`,
`setHeaders`) is exactly where the check should have started.

---

## 2026-09-01 — Production died twice in one afternoon, and neither death was the code

**What happened:** The production Hub on 4545 went down twice within hours of
the v2.21 deploy. Danny's phone got Cloudflare 502s; the farm's scheduler was
dead both times. First suspicion fell on the brand-new WebSocket proxy — an
async write to a dead socket IS process-fatal in Node, and that path had just
shipped — so it was hardened and a crash logger added. crash.log then stayed
EMPTY across the second death: the process was being killed, not crashing.

**Root cause:** I had restarted production through the remote-automation
bridge, which makes the Hub a child in the bridge's process tree (job object).
When the bridge recycles its sessions — which it did at 13:57, the exact minute
of the first death — every descendant is killed with it, `start`/detach
notwithstanding. The Hub that had run for hours before was one Danny started
himself; every one of mine died young. Meanwhile cloudflared (running since
Aug 27, its own orphan) kept the tunnel up and served 502s over the corpse,
which made the outage look like a Cloudflare problem.

**Consequence:** two silent production outages, an hour of suspecting the wrong
component, and — the useful part — a genuine crash-hardening pass and crash.log
that were worth shipping anyway.

**Fix:** `scripts/restart-4545.cmd` now starts the Hub via WMI
(`Win32_Process.Create`), which creates it OUTSIDE the caller's process tree;
console output goes to `hub-console.log` so a real crash finally leaves a stack
somewhere readable. The websocket/proxy hardening and the
uncaughtException→crash.log handler stay: they close a real (if unproven-here)
kill path, and the harness now asserts the Hub survives both a refused upgrade
and a client abandoning the handshake.

**Rule:** a long-running service must never be a child of the tool that
deployed it. And when a process dies with no crash evidence, ask who KILLED it
before asking what broke — absence from crash.log is itself a finding.

---

## 2026-09-01 — Three UX corrections from Danny in one afternoon, one lesson

**What happened:** In quick succession: *"get rid of the add buy link button and
just have the search button say something like 'replenish on Amazon'"*; *"there
is nowhere in the settings to turn off the Amazon affiliate code"*; *"the in-app
slicing is not ready… maybe have a warning that pops up when checked."*

**Root cause, common to all three:** I placed controls where the CODE's
structure put them, not where a person would look. The buy label exposed an
internal distinction (saved URL vs search) nobody shopping for filament cares
about. The affiliate switch lived only inside the Resources tab's disclosure
line because that module owns the setting — but a person looking for a setting
opens Settings. And an unfinished feature's checkbox looked exactly like every
finished feature's checkbox, with the warning living only in a code comment.

**Fix:** one label ("Replenish on Amazon") on both tabs; a "Supporting the
project" section in Settings wired to the same `/api/resources/affiliate`
switch (plus a GET so Settings can read it); a confirm() on the slicing box
naming the fork URL, with Cancel reverting the tick.

**Rule:** module boundaries are for code, not for controls. A setting belongs in
Settings whatever module owns it; a label describes what the user gets, not
which branch produced it; and a feature that is not ready has to say so at the
moment of enabling, in the user's face, not in a comment.

---

## 2026-09-01 — A notice that outlived the thing it was about

**What happened:** Danny deleted a roll from his filament library. The Resources
tab then told him, on every render and for as long as he kept the Hub open,
"1 inventory entry belongs to a spool that no longer exists (600 g @ $25) —
harmless, but nothing points at it any more." His words: *"this needs to go
away. I should be able to delete filament from my library without having a
perpetual message about it."*

**Root cause:** I designed the 2.16 orphan report and the 2.19 `forget` button
around the wrong question. I asked "how do we avoid silently losing a person's
typed-in numbers?" and answered it with a permanent banner plus a button. The
question I never asked was "what did the user mean by deleting the roll?" —
because deleting filament from the library *is* the instruction to forget its
numbers. Every render after that was the software re-litigating a decision he
had already made, and demanding a second click to accept it.

Worth noting what the 2.19 fix got right and wrong at once: I had already spotted
that "a report you cannot act on stops being read", and shipped a button. A
button is still work. The report itself was the defect.

**Consequence:** a permanent false alarm on the tab that is supposed to be the
farm's honest inventory picture, for two weeks, on the machine he actually uses.
Alarms that cannot be cleared teach you to stop reading alarms — and the same
banner block carries the real orphan warning.

**Fix:** `reconcileInventory()` drops the entry automatically, guarded twice —
only when the shelf read was *authoritative* (a parsed `spools.json`, not an
EIO on the SMB share, which would otherwise look like "he threw away every roll
he owns"), and only when nothing in `color_map` still points at that spool id.
The second guard is what keeps this from being data loss: a colour deliberately
mapped to a roll that is briefly off the shelf still names it, and that case is
still reported — with new wording that says the numbers are being *held for the
replacement*, which is true and actionable, rather than that they are litter.
The dropped grams and price go to the hub log on the way out.

**Rule:** when a state is the *expected consequence of something the user just
did on purpose*, it is not a warning. Reconcile it and move on. Reserve the
banner for states the user did not ask for and can still do something about —
and if the only offered action is "confirm what you already told me", there was
never anything to report.

---

## 2026-09-01 — A printer taken out of service still read "IDLE" on the Dash

**What happened:** Maintenance mode shipped an hour after the buy-links entry
below, which is an entry *about shipping onto one surface only*. I then shipped
maintenance mode onto one surface only. U3 was genuinely parked —
`/api/dispatch` carried `maintenance: {"2": {…}}`, the scheduler was routing
around it — and its Dash card said **IDLE**, with Upload and Print sitting right
there. The Match tab likewise offered it as an ordinary target.

**Root cause:** maintenance was stored in `dispatch.js` and read by the Dispatch
guide, which is where I built and tested it. `/api/fleet` — what the Dash and
Match tabs render from — did not carry the field at all, so no other surface
could have shown it even if its markup had wanted to.

**Consequence:** the exact invitation the feature exists to prevent: send a job
to a machine you have just told the scheduler not to send jobs to. Caught by me,
not by Danny, and only because I checked the *surface* instead of the API — the
lesson from the buy-links failure, applied one hour later, on the very next
feature. That is how narrow the gap was.

**Fix:** `dispatch.js` provides `dispatch.maintenance`; `fleetSnapshot()` in
`server.js` resolves it at call time and merges `maintenance: {since, note} |
null` onto every printer. The Dash card gets a `maint` pill, a card style and a
`maintline` in words; the Match card gets a tag and a card style. Manual
printing to a down machine is still allowed on purpose — you want to test-print
after a repair — but it can no longer happen without reading the word
"maintenance". Five harness checks now assert the field *and* the markup.

**Rule:** a fact about a printer belongs to the fleet, not to the module that
happens to own its storage. Before calling a feature done, list every surface
that draws that object and check each one — the count is the deliverable, not
the first tab that works.

---

## 2026-09-01 — Shipped a feature onto one of the two surfaces that needed it

**What happened:** The Amazon affiliate search shipped in 2.19 on the Resources
tab. Danny went to the **Spools** tab — where you actually manage rolls — and
found "add buy link" and nothing else against all eight spools. "The buy links
aren't live." He was right, on the tab he was looking at.

**Root cause:** two things, and only the second was a coding error.

The first: I built for the surface I had open. `/api/resources` grew a `buy`
field; `/api/resources/spools`, which feeds the Spools tab, did not. The Spools
markup in `index.html` still gated its link on `v.purchase_url` — and no real
shelf has purchase URLs typed in, which is the exact reason the search fallback
was built. So the feature was invisible precisely where it was most useful.

The second: the Resources control opened via `window.open()`. A popup blocker
eats that silently — no error, no tab, nothing to diagnose — which is
indistinguishable from "the feature is broken". Now a real `<a target="_blank">`,
which is never blocked, and is middle-clickable and copyable besides.

**Why the harness missed it:** every check asked `/api/resources` whether rows
carried a tagged link. None asked the *other* endpoint, and none asked whether
the markup rendered what the API returned. An API contract test is not a test
that the feature is reachable.

**Rule:** when a feature adds a control, list every surface that shows that kind
of thing and check each one — a grep for the neighbouring control (`invbuy` here)
would have found the second surface in seconds. And for anything user-visible,
one check must assert the MARKUP renders it, not merely that the API offers it.
Related: prefer a real anchor to `window.open` for anything navigational; a
silent failure mode is worse than an ugly one.

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

---

## Moved to `MISTAKES-shared.md` - six entries, 2026-09-21

Six entries dated 2026-09-07 used to sit here. They are **not u1-print-hub
mistakes** - they happened in conduit-os, Scout and the machine's MCP config -
and CLAUDE.md is explicit that a mistake made in another project belongs in
that project's log or in `C:\Users\Danny\code\MISTAKES-shared.md`, not here.

Nothing was deleted. The full write-ups live in
`C:\Users\Danny\code\MISTAKES-shared.md`:

| Entry | In the shared log as |
|---|---|
| Told Danny his production code was not in git, from a stale ref | 2026-09-05 - "Led an evaluation with 'your production code is not in git', from a three-month-stale ref" |
| Quoted "$79 and up to 200 runs" for a tick that cost $1.48 | 2026-09-05 - "Quoted a '200-item backlog' and a $79 saving from a count whose filter I had already read" |
| Repeated a Supabase security advisory three times without testing it | 2026-09-05 - "Repeated a security advisory as a finding, three times, without ever testing it" |
| Reported a moving number as if it were settled | moved 2026-09-21, same title |
| A handoff summary claimed MISTAKES.md entries that were never written | moved 2026-09-21, same title |
| `npx @latest` in the MCP config, and three orphaned servers | moved 2026-09-21, same title |

The first three were **already** in the shared log, under earlier and fuller
write-ups, before this move - the copies here were thinner duplicates carrying
a different date. Trust the shared log's dates: those entries describe the
session they actually happened in.

The promoted-cluster table at the top of this file still counts all six, and
that is deliberate - the lesson families (rule 8 above all) are machine-wide,
not per-repo.
