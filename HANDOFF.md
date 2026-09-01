# HANDOFF — U1 Print Hub, after v2.16.0

Written 2026-09-01. Read this first, then `CLAUDE.md`, then `MISTAKES.md`.

---

## 0. First actions for the next session

**Check the link before anything else.** This work needs Danny's desktop, **ichabod**
(Windows), reachable through the `mcp__remote-devices__*` tools. If those tools are not in
your tool list — not loaded, not deferred — **the session is not linked and no retry will
help**. Say so in your first message and stop; do not silently fall back to a cloud clone of
`main`, because `X:` is the source of truth and a cloud clone will drift from it.

The link is chosen when the task is created and cannot be granted mid-session from a phone.
To fix: open the task in the Claude desktop app **on ichabod** and choose "Link to this
computer"; if that option is not offered, start a fresh task from the desktop app on ichabod
and paste this handoff in. Starting Hub work from the desktop app on ichabod avoids the
problem entirely.

Once the tools are present, load these immediately via `ToolSearch` — they are deferred and
must be fetched before use:

```
ToolSearch: select:mcp__remote-devices__desktop-commander__read_file,
mcp__remote-devices__desktop-commander__write_file,
mcp__remote-devices__desktop-commander__edit_block,
mcp__remote-devices__desktop-commander__start_process,
mcp__remote-devices__desktop-commander__start_search,
mcp__remote-devices__desktop-commander__get_more_search_results,
mcp__remote-devices__desktop-commander__list_directory
```

Also available if needed: `mcp__claude-in-chrome__*` (his real Chrome, for screenshots and
UI verification — start with `tabs_context_mcp`), `TaskCreate` / `TaskUpdate`,
`WebSearch` / `WebFetch`.

### Environment facts that will cost you an hour if you learn them the hard way

- **`device_bash` does not start on this machine.** Desktop Commander's `start_process`
  IS the shell. Do not retry `device_bash`.
- **Source of truth is `X:\u1-print-hub`** (mapped to `\\192.168.12.81\share`). Never read
  or reason from the `C:\Users\Danny\code\u1-print-hub` clone — it holds git history and is
  the only place to commit. `X:\u1-print-hub\.git` is stale (tag `v2.6.0`) and must never
  receive a commit.
- **60-second per-call ceiling on the bridge.** Never run `npm test` in the foreground. Use
  `scripts/run-harness.cmd`, launched hidden via `Start-Process`, and poll
  `scripts/harness.log` in <=55 s chunks.
- **Never blanket-kill `node.exe`** — Desktop Commander *is* node. Kill by command line or by
  listening port.
- `X:` cannot be granted through a folder-access request; Desktop Commander reaches it
  directly.
- The live Hub runs on **port 4545** from `X:\u1-print-hub` in a visible cmd window. Nine
  printers (U1-U9) on 192.168.12.x, usually mid-print.
- **`X:` rejects tmp+rename.** Any state writer must use the fallback pattern now documented
  in `modules/dispatch.js` `save()`.

---

## 1. Where things stand

**Commit `ec51301`, pushed `3914dc1..ec51301 main -> main`** on `github.com/dlgambill/u1hub`.
21 files, +2329 / -41. Version **2.16.0** across `server.js`, `public/index.html`,
`package.json`.

**Harness: 371 passed, 0 failed** (up from 323). Every new check was falsification-verified
per rule #6.

Shipped in this release:

- Resource Monitor, end to end (parser -> rollup -> UI -> inventory store)
- Tagless-roll QR door (server side already existed; only the UI entry point was missing)
- Mobile card layout for the Resources table
- Match tab top-5 with a "see more" expansion
- Inline `$/roll` editing
- Klipper link on printer names (a Reddit community request)
- Orphaned-mapping fix
- **The SMB save bug fix** — removed dispatch jobs were coming back
- Two wall-clock test fixes
- Hard rules #6, #7, #8 in `CLAUDE.md`
- Three screenshots in `docs/`, README v2.16 section
- Two short social posts (drafted in chat, **not yet in `share-posts.md`**)

There are no README sections for 2.12-2.15. Those versions were never launched — the work
just kept going.

---

## 2. What changed, file by file

### `parser.js` (+113)
Extended with `parseAmounts(cfg, text)`. Purely additive — nothing existing reads `amounts`,
so `/api/map`, Spool Match and dispatch `fileInfo` are untouched.

```js
const AMOUNT_KEYS = {
  grams: ["filament used [g]", "filament used [grams]", "filament_used_g"],
  mm:    ["filament used [mm]", "filament used [millimeters]"],
  cm3:   ["filament used [cm3]", "filament used [cm^3]"],
  cost:  ["filament cost"]
};
// grams = pi * (d/2)^2 * mm * density / 1000
```

Returns `{slots, slot_sum_g, total_g, total_cost, tool_changes, unaccounted_g,
suspect_unaccounted, have_grams}`. Also exports `parseAmounts, parseConfig, gramsFromLength,
normHex, splitAligned`.

### `modules/resources.js` (NEW, 561 lines)
The whole server side.

```js
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const COUNTED_STATES = new Set(["queued", "printing", "paused"]);
const DEFAULT_MATCH_DE_MAX = 7;   // tuned on real data
const REVIEW_DE = 3;
```

Endpoints: `GET /api/resources`, `GET /api/resources/spools`,
`POST /api/resources/inventory`, `POST /api/resources/map`,
`POST /api/resources/settings`, `GET /api/resources/badge`.
Provides capability `resources.rollup`.

**`readShelf()` contains a known defect — see section 4, Priority 1.**

### `public/modules/resources-ui.js` (NEW, ~472 lines)
Columns: Material | Colour | Needed | On hand | Short | Rolls | $/roll | Est. cost | Buy.
`On hand` and `$/roll` share one inline-edit handler (`data-inv` + `data-k`). Below 700 px
each row becomes a card with `data-label` pairs. The table is wrapped in `.rscroll`
(`overflow-x:auto`) — **never `html`/`body` overflow**, per the Cloudflare incident in
`MISTAKES.md`.

### `modules/dispatch.js` (+49) — the SMB fix

```js
let SAVE_FALLBACK = false;                     // latched, so we warn once
function save() {
  const data = JSON.stringify(D, null, 2);
  const tmp = FILE + ".tmp";
  if (!SAVE_FALLBACK) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, FILE);                // atomic on a local volume
      return;
    } catch (e) {
      SAVE_FALLBACK = true;
      ctx.hublog("warn", "dispatch: atomic save failed (" + e.code + " " + e.message + ")");
    }
  }
  fs.writeFileSync(FILE, data);                // not atomic, but it lands
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
}
```

Also replaced the silent `setInterval(() => { tick().catch(() => {}); })` with a
rate-limited logging catch.

### `server.js` (+32)
Three registrations (`MODULE_DEFAULTS` with `resources: true`, `CLIENT_TABLE`,
`MODULE_TABLE`), `url: p.url || null` added to `fleetSnapshot()` for the Klipper link, and a
`U1HUB_PORT` env override on `PORT`.

### `public/index.html` (+153)
Match tab top-5 (`MATCH_PREVIEW = 5`, `MATCHMORE` Set, `idleThrough`-safe expansion), spool
inventory chips in `loadSpools()`, the "New roll (no tag)" button wired to
`openBindPanel(null)`, printer-name `<a class="pn pnlink">`.

### `test/run-tests.js` (+283)
New sections: `PERSIST` (4 checks), `UI: printer name links` (3), `RES: Resource Monitor`
(~25). Plus wall-clock fixes at ~line 991 and ~line 1108.

### New standalone harnesses — these run against REAL gcode, not fixtures
- `test/amounts-standalone.js` — 44 assertions on real 54 MB files
- `test/resources-standalone.js` — rollup invariants against the live schedule
- `test/de-nearwhite-standalone.js` — the dE 7 regression gate

### New scripts
- `scripts/run-harness.cmd` — the 60 s ceiling workaround
- `scripts/check-index-js.js` — syntax-checks inline `<script>` in index.html
  (`node --check` only covers `.js`)
- `scripts/smoke-resources.cmd` — boots a throwaway Hub on 4546

### Docs
`CLAUDE.md` now has 8 hard rules (new: #6 a new check must be shown to fail; #7 a test must
not depend on when it runs or what else is running; #8 verify before you assert or act),
plus a "Working over the bridge" block and a "Known determinism debt" section.
`MISTAKES.md` is at 18 entries with a promotion-index table at the top.

---

## 3. Decisions worth not relitigating

- **Purge is not `total - sum`.** Verifying the parse target on real files before writing the
  parser corrected the original spec: an 88-tool-change job reconciles to 0.01 g, because
  Orca charges flush to the purging slot.
- **dE ceiling is 7**, settled on measured evidence after 25 and 10 both proved too loose:
  white sits 14.2-17.5 from every bone/flesh; the closest bone/flesh pair (`#F8E1C2` vs
  `#EAC9B0`) is 7.3.
- **`resources.json` is a separate store**, not new columns in `spools.json` — `rfid.js`
  rewrites that file on every tag bind.
- **Scope is everything scheduled**, regardless of deadline feasibility, with a checkbox to
  confine it to the deadline.
- **Counted states**: queued + printing + paused.

---

## 4. Backlog

### Priority 1 — a defect shipped in 2.16.0

**Phantom spools in `readShelf()`.** `STATE.local` in `spools.json` is the **local colour
library**, not a shelf of physical rolls (`rfid.js` line 142:
`const pool = SNAP.swatches.concat(STATE.local)` — it is concatenated with the 2,266
FilamentColors swatches for *searching* when binding a tag). `readShelf()` currently adds all
7 of them as spools:

```
id=-1                     #C44FFF   <- no brand, no name
id=-5  Panchroma Yellow   #888888   <- placeholder grey, not yellow
id=-6  Panchroma Magenta  #888888   <- same
```

They pollute the match pool, appear in the "map to spool" dropdown, and get a default 1000 g
net weight.

**Fix:** drop the `local` line from `readShelf()`. `spools` already contains tagless
"New roll" entries, so nothing real is lost.

**Catch:** the RES harness fixtures use `local: [{id:-101},{id:-102}]` as the test shelf, so
~12 checks must be rebuilt onto `spools: {}` first — including the orphan block, which
asserts `orphan_of === "-101"`.

Sequence:
1. Rebuild the RES fixtures onto `spools: { "sp_test_red": {...}, "sp_test_green": {...} }`.
2. Remove `for (const s of (raw.local || [])) ... add(String(s.id), s, "local");` from
   `readShelf()`.
3. Falsify (rule #6), run green, then confirm on the live Hub that the 7 phantom entries are
   gone from the map-to-spool dropdown.

~30 min with verification. **Danny has not yet said go on this — confirm first.**

### Priority 2 — harness honesty

- The flaky **"released job is free to be claimed against reality again"** check races the
  10 s executor tick. Rule #7 says that is a defect, not a quirk — a red harness is currently
  ambiguous. Fix: set the mock to `standby` before asserting, or drive `/api/dispatch/tick`.
  ~30 min.
- **`run-tests.js:1401`** still compares against `Date.now()`. Safe on a normal day; red at
  23:59 on a spring-forward day. ~10 min.

### Priority 3 — features

**Amazon affiliate links.** Designed, not built. Danny's tag: `3dfil06-20`. He decided:
disclose it, and add a Settings checkbox so any user (himself included) can turn it off.

Shape: `config.affiliate = { amazon: "3dfil06-20", enabled: true }`, a Settings checkbox, a
disclosure line under the Buy button, and ASIN normalisation (rewrite any Amazon URL to
`amazon.com/dp/<ASIN>?tag=...`). Search links work with zero credentials — that half is ~1 hr.

Price and availability need PA-API 5.0, which requires 3 qualifying sales. Amazon does not
pay commission on your own purchases ("orders for products to be used by you, your friends,
your relatives, or your associates"), so he cannot bootstrap it himself — and he should blank
the tag on his own install.

**Mobile horizontal overflow on the Match and Dispatch tabs.** Same bug that was fixed on
Resources; both still push the page sideways. ~20 min each. Deliberately not touched
uninvited.

**A "clear it" button for orphaned inventory.** The warning names the stranded 600 g / $25
but offers no way to remove it.

### Priority 4 — docs and housekeeping

- `share-posts.md` — append the two short v2.16 posts under a v2.16 heading. Fix the
  `github.comts` typo (correct URL: `https://github.com/dlgambill/u1hub`).
- `filament-swatches.json` has been dirty in the C: clone since before this session,
  unexplained and uncommitted.
- `dispatch.json.bak-0901-0045` and `dispatch.json.tmp-0901-0045` on `X:` — now gitignored,
  Danny's to delete once he is satisfied.
- `.gitignore` was part UTF-16 (16 NUL bytes at offset 928), which meant `slicejobs.json` was
  silently **not** ignored. Rewritten as clean UTF-8; all 12 state files verified ignored.

---

## 5. Mistakes from this session, so they are not repeated

- **Told Danny `npm test` was his to run.** He replied: *"I'm not in a position to run npm
  test."* The workaround was documented in his own `MISTAKES.md` four entries down. Built
  `scripts/run-harness.cmd` and ran it here instead.
- **Called 323 "green" repeatedly** while adding ~950 lines with zero harness coverage. An
  unchanged check count after a large feature is itself the signal.
- **Two wall-clock test failures at 23:02.** Both fixed plan-derived; `busyAt` ->
  `idleThrough(p, est_start, est_end)`. Verified by re-running inside the 23:00 hour.
- **dE ceiling wrong twice** before settling on measured evidence.
- **Facebook post typo** — wrote `https://github.comts/dlgambill/u1hub`.

---

## 6. Suggested opening move

> "Backlog's in `HANDOFF.md`. Priority 1 is the phantom-spool defect in `readShelf()` — the
> only live defect in code shipped in 2.16.0. Want me to take it?"

---

## 7. Addendum — v2.17.0 (2026-09-01, same day)

**Harness: 382 passed, 0 failed** (was 371). Eleven new checks, all falsified
first via `test/gold-falsify-standalone.js`. Version 2.17.0 across `server.js`,
`public/index.html`, `package.json`. **Not committed** — `X:` only so far.

### What changed

`public/gold.css` gained a v2.17 section (150 → 289 lines). No new stylesheet,
no `index.html` markup change — the `<link>` was already there from v2.11.

- **Token repair, and it was a live bug.** `index.html` referenced
  `var(--accent, #FFB200)` and `var(--card, #161a22)`; neither property was
  defined anywhere, so the filament-memory bar stayed U1 amber while
  `applyAccent()` re-accented everything else on a non-U1 fleet. Two aliases
  (`--accent:var(--signal)`, `--card:var(--panel)`) fix every existing reference
  with no edit to the inline CSS. Proven live: setting `--signal` to `#5BC0EB`
  now drives the bar's buttons to `rgb(91,192,235)`.
- **Radius scale.** Five tokens, assigned by role, applied to the component
  families. Swatches, dots, progress fills and the camera tile keep their own
  geometry deliberately.
- **Tabular figures** on the live readouts. Outfit has proportional digits, so
  every temp and percentage tick was shifting its row sideways on each poll.
- **Focus coverage for everything added since v2.11** — Resources, the Match
  top-5 footer, the inline `$/roll` editor, row actions, camera controls,
  Dispatch's own controls. Same `outline` + `color-mix` language as the v2.11
  block, so the two are indistinguishable in use.
- **The source-filter checkboxes were `display:none`**, which took them out of
  the tab order entirely. They were unreachable by keyboard, not merely
  unstyled. Now clipped-but-focusable.

The new checks also pin gold.css's own standing rules: it may never assign a
semantic colour token (that would freeze `applyAccent()`), never use
`transition: all`, and never use a CSS keyword easing.

### New backlog item, found during the audit

**`dispatch-ui.js` is styled entirely off-system.** ~200 lines of inline style
with ~60 hardcoded hex values (`#444`, `#1b1e24`, `#23262d`, `#889`, `#9aa`,
`#c66` …) that bypass the token layer, and its `var(--signal, …)` fallbacks are
`#d6a832` rather than the real `#FFB200`. Largest remaining consistency gap in
the UI. It is a restyle of another module, not a discipline pass, so it wants
its own change with its own verification.

Also newly recorded, in gold.css's own "deliberately not done" block:
`.mname` (Match row expander) and `.dsp-blk` (Gantt blocks) carry click handlers
on non-focusable divs. No CSS can reach them — they need `tabindex` plus a
keydown handler, which is a JS change.

### Two mistakes logged this session

`MISTAKES.md` gained two entries: auditing `index.html` without reading the
`gold.css` it links (a rule-8 repeat, now 5 incidents — rule #1 in `CLAUDE.md`
was extended to "read what it loads"), and the bridge silently stripping `$`
from PowerShell commands.

### Still open from §4

Priority 1 (phantom spools in `readShelf()`) is **untouched** — still the oldest
live defect. The update notifier Danny asked for is **not started**; note that
the Hub already ships a page-vs-server version banner, which is the same
mechanism aimed at a different question.

---

## 8. Addendum — v2.18.0 (2026-09-01, same day): the update notifier

**Harness: 404 passed, 0 failed** (was 382). Twenty-two new checks. Version
2.18.0 across the three files. **Still not committed** — `X:` only.

### What it is

A Hub can now tell its owner that a newer release exists. Deliberately separate
from the `#vbadge` already in the topbar: that one compares the loaded page
against the server process answering it and is entirely local. This one asks
whether there is a newer release upstream.

**Files:** `modules/updates.js`, `public/modules/updates-ui.js`, `update.json`
(the published manifest, at the repo root — this one IS committed), plus
registrations in `server.js` and `version: VERSION` added to `MODULE_CTX`.

### The four constraints that shaped it

1. **Offline is the normal case, not an error case.** Most installs are on a
   LAN and some have no route out at all. A failed check never blocks a request,
   never shows a red banner, and never invents an update. `GET /api/updates`
   answers from cache and kicks any actual network call off asynchronously; the
   fetch aborts at 6 s. Verified: a mock host that accepts the connection and
   then says nothing aborts at 6016 ms.
2. **The check leaks nothing.** A plain GET of a static JSON file — no version,
   no install id, no query string. Danny gets no telemetry from this, and the
   UI says so in the panel. If that ever changes it stops being a version check
   and becomes analytics, which needs its own consent conversation.
3. **Off means no request at all**, not "made and discarded". The harness proves
   this with a hit-counting mock rather than asserting it.
4. **Numeric version comparison.** String compare says `"2.9.0" > "2.17.0"`,
   which would tell everyone on the newest build they were behind — the most
   embarrassing possible failure for an update notifier.
   `test/updates-standalone.js` runs a 16-case ordering table and then
   demonstrates that the naive implementation actually fails it.

### Two things the live gate caught that the harness could not

- The chip originally rendered `v2.18.0` at rest — directly beside `#vbadge`,
  which already prints exactly that. Two identical version strings in the
  topbar reads as a bug. At rest it is now a `↻` glyph with an accessible name;
  it becomes `update: vX.Y.Z` in the accent colour when there is news.
- Pointing the timeout test at `203.0.113.1` (TEST-NET-3) failed, because the
  module's own URL validation correctly refuses plain http to a public address.
  The test now uses a deliberately silent mock instead, which exercises the
  abort properly rather than relying on the network.

### Settings

`config.updates = { enabled: true, url: <manifest>, interval_hours: 24 }`.
The manifest URL must be https, with one carve-out: plain http to a loopback or
RFC1918 address, so an air-gapped farm can mirror releases internally without
needing a certificate. `features.updates: false` removes the API and the client
script entirely, same contract as every other module.

### Release procedure this adds

`update.json` at the repo root is what every install fetches. The harness pins
its `version` equal to `package.json`, so a manifest that lies about the current
release cannot ship. Bump it as part of cutting a release. Note that
`update.json` (committed manifest) and `update-state.json` (per-install cache,
gitignored) are deliberately named apart — an earlier draft called the state
file `updates.json`, one letter from the manifest, which is exactly how the
wrong one ends up committed.

### New tooling

`scripts/boot-4546.cmd` / `scripts/stop-4546.cmd` — a throwaway Hub on 4546 for
live gates. Used instead of restarting production: 4545 is dispatching nine
printers mid-print, and restarting it is the user's call. The throwaway shares
this folder's state files, so it is read-only in practice — never POST anything
that writes `config.json`.

### Still open

Priority 1 (phantom spools in `readShelf()`) is **still untouched**. The
`dispatch-ui.js` off-system styling from §7 is still the largest consistency
gap. Nothing from v2.17 or v2.18 has been committed or pushed.

---

## 9. Addendum — v2.19.0 (2026-09-01): the backlog, cleared

**Harness: 450 passed, 0 failed** (was 323 at the start of the day).
**Committed locally as `3d073eb`, one commit ahead of `origin/main`. Not pushed.**
Production on 4545 restarted onto 2.19.0 and verified: 9 printers online, U3 down
for maintenance, 8 real spools on the shelf, version banner clean.

### What shipped

- **Maintenance mode.** `POST /api/dispatch/maintenance {printer, down, note}`,
  a button on every Dispatch lane, state in `dispatch.json`. Marking up or down
  clears `PLACEMENT` — without that the queue stayed where it was pushed and the
  repaired machine sat idle beside work it could do.
- **Update notifier** (`modules/updates.js`), **affiliate links**, **orphan
  clear**, **keyboard reach**, **dispatch-ui.js on tokens**, **`U1HUB_DIR`**.
- Full detail is in `README.md` under "New in 2.19" and in the commit message.

### Two things that were wrong in §4 and §7 of this document

- **Mobile overflow on Match and Dispatch was already fixed.** Measured at 390 px:
  `scrollWidth === clientWidth` on all five tabs. The claim had been carried
  forward unverified since 2.16. Logged in `MISTAKES.md`. What did need doing
  was the view-tab row, which was truncating labels; it wraps now.
- **The affiliate off-switch had a one-way-door bug** the harness could not see,
  because every fixture set a tag before toggling. Caught on the throwaway
  instance. Also logged.

### For Danny specifically

**Turn the affiliate tag off on your own install.** It is on by default and
currently tagging all 46 rows on your farm. Amazon does not pay commission on
purchases by the account holder or their friends, relatives and associates — so
tagging your own filament orders earns nothing and puts the associate account at
risk. One click: Resources tab → the disclosure line → "Turn off". That writes
`affiliate.enabled: false` to your `config.json` and no tag is applied anywhere.
The default stays on for everyone else, which is what you asked for.

**`update.json` needs to reach `main`** before the update notifier does anything.
Until it is pushed, every Hub's check gets a 404 and shows nothing — correct
behaviour, but the feature is inert.

### Still open

- `filament-swatches.json` is still dirty in the C: clone, unexplained, and was
  deliberately left out of the commit.
- `dispatch.json.bak-0901-0045` / `.tmp-0901-0045` on `X:` — gitignored, yours
  to delete.
- Scheduled maintenance windows ("U5 is down Tue–Thu") were considered and not
  built; the simple flag is the foundation if you ever want them.
- The Product Advertising API half of the affiliate feature remains blocked on
  three qualifying sales, which cannot be self-generated.

---

## 10. Addendum — v2.20.0: push a job back

**Harness: 465 passed, 0 failed.** Version 2.20.0 across the four files.

### The problem, in Danny's words

> "I've got three prints scheduled to start at the same time, all using green. I
> know I can move them to another printer, but it'd be great if I could just
> push them back and do the next job instead."

The Hub already detected this — `findContention()` has flagged spool clashes
since 2.13, and the module comment is explicit that it will not silently
serialise, because invisible constraints leave you staring at a plan wondering
why nothing starts. What was missing was a way to *answer* the flag.

### What was built

`job.after` — the id of the job this one was pushed behind. `POST
/api/dispatch/jobs/push-back { id }` resolves "the next job" against the CURRENT
plan and stores that relationship; `{ id, clear: true }` undoes it. A button on
the job sheet, which stays open on success so a second press is immediate.

Three design points worth keeping:

- **It stores a job, not a time.** Danny's own framing — "I might get the
  filament while the others are still printing. If not, I can push back again"
  — is a relative nudge, repeated as needed. A timestamp would go stale the
  moment anything upstream moved.
- **It waits for the target to FINISH, not to start.** Flooring at the start
  would let the two overlap on different machines, which is the exact situation
  being escaped.
- **Two passes in `plan()`.** A job can only be floored against a target that
  has already been placed, so `ordered` is rearranged first. Cycles and dead
  targets are dropped rather than trusted — `after` lives in `dispatch.json`,
  which a human can edit. A hand-written cycle plans in 39 ms instead of hanging.

### Verified on the real queue

His farm had **31 of 38 slots contended**, not the three he described. Pushing
`Alien x4.gcode` back once moved it Wed 06:00 → Thu 06:00 and cleared its black
clash; a second press moved it behind the next job again. Note that the farm
total went 31 → 32 → 31 across those presses: resolving one clash can expose
another when one roll is wanted by many jobs. That is honest and is reported,
not hidden.

### Also fixed: `filament-swatches.json`

Dirty in the C: clone since 2026-08-18 and unexplained. The entire diff was the
`fetchedAt` timestamp — all 2,266 swatches byte-identical. `npm run
refresh-filament-db` stamped the time on every run, so a refresh that found
nothing new still rewrote a 900 KB single-line file. The script now writes only
when the DATA differs and reports the check date on stdout instead; `fetchedAt`
therefore means "when this data last actually changed". The working copy was
reverted, since it carried no information the repo did not already have.

---

## 11. Addendum — v2.20.0 (2026-09-01, later): every surface, and a notice that outlived its subject

**Harness: 481 passed, 0 failed.** Standalone suites: 8, now runnable in one go
with `npm run test:standalone`. Committed locally as `868bab9`. **Three commits
are unpushed** — `update.json` stays inert until Danny pushes.

### Maintenance was only ever visible on one tab

Found while answering "what's left?", by checking the *surface* rather than the
API — the lesson from the buy-links failure, applied an hour later to the very
next feature, and it caught the same class of bug again. U3 was genuinely parked
(`/api/dispatch` carried `maintenance: {"2": {…}}`, the scheduler was routing
around it) and the **Dash card said IDLE**, Upload and Print right beside it.
The Match tab likewise offered it as an ordinary target.

`dispatch.js` now does `ctx.provide("dispatch.maintenance", …)`; `fleetSnapshot()`
in `server.js` resolves that capability *at call time* and merges
`maintenance: { since, note } | null` onto every printer. Dash gets a
`Maintenance` pill, a `.pcard.maint` border and a `.maintline` that says it in
words; Match gets a `⚒ maintenance` tag and a `.matchcard.maint` border.

Deliberate: a down machine is **not** removed from Match and manual printing to
it is **still allowed** — you want to test-print after a repair. It simply
cannot happen any more without reading the word "maintenance". Also deliberate:
the accent colour, never `--bad`. Nothing is broken; it is parked on purpose.

Live-gated on the throwaway 4546 Hub seeded from production: U3's Dash card
reads `pill: "Maintenance"`, `class: "pcard offline maint"`; parking an *online*
machine (U1) put `⚒ maintenance` on its Match card while the other seven stayed
plain.

### Deleting a roll left a permanent notice behind

Danny, with a screenshot: *"this needs to go away. I should be able to delete
filament from my library without having a perpetual message about it."* The
Resources tab had been reporting `1 inventory entry belongs to a spool that no
longer exists (600 g @ $25)` on every render since he deleted the roll, with the
2.19 `forget` button as the only exit.

He is right, and the root cause is a design question I never asked: deleting
filament from the library **is** the instruction to forget its numbers. The
banner was the software re-litigating a decision he had already made.

`reconcileInventory()` (modules/resources.js) drops the row automatically,
guarded twice:

1. **Authoritative shelf only.** `readShelf()` now reports whether an empty or
   short shelf is a *fact* (a parsed `spools.json`, or no file at all) or a
   *failed read*. `spools.json` lives on an SMB share; one EIO would otherwise
   look exactly like "he threw away every roll he owns".
2. **Nothing may still reference it.** If a colour in `color_map` still names
   that spool, the numbers stay and are reported — with new wording saying they
   are being *held for the replacement*, which is true and actionable. Re-adding
   the spool restores everything intact, which the harness has asserted since
   2.19 and still does.

Dropped grams and price go to the hub log, so the number is recoverable.

Verified on the real install: `resources.json` went from four inventory keys to
three the first time the restarted Hub served `/api/resources`;
`sp_msmng7iw71fzez` is gone and the banner with it.

### Testing

- `test/inventory-reconcile-standalone.js` — 17 cases, including the share-
  failure guard and a numeric-vs-string spool id.
- `scripts/falsify-reconcile.js` — five mutations of `resources.js`
  (drop each guard, don't delete, treat a parse error as authoritative, compare
  ids without `String()`), **all five caught**.
- `scripts/falsify-matchmaint.js` — proves the two Match-tab markup checks fail
  when the class expression, the tag, or the card style is removed.
- Five new checks in `test/run-tests.js` (472 → 481): `/api/fleet` reporting
  maintenance and `null`, the Dash markup, the Match markup, and the live
  auto-prune asserted **on disk**, not just in the API response.
- `npm run test:standalone` runs all eight standalone suites. They had drifted
  into "run directly" meaning "never run".

### Still open (unchanged, and all Danny's call)

- **Three commits unpushed.** `update.json` cannot notify anyone until then.
- **Affiliate tag is live on his own install** (46 rows). Amazon does not pay on
  the account holder's own purchases — worth turning off locally, one click.
- **The spool shelf is only partly entered.** White and pink still match no
  spool at all, and the black contention warnings are expected fallout: he buys
  black eight rolls at a time but has entered one. He has looked at this and
  said the warnings are fine — do not "fix" it with inventory-derived
  contention. That was proposed and declined on 2026-09-01.
