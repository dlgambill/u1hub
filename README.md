# U1 Print Hub

![U1 Print Hub dashboard — farm view with live prints and the filament color picker](docs/dashboard.png)

A small local dashboard for a farm of **Snapmaker U1** printers. From your phone or
any browser — on your network, or **securely from anywhere** — you can:

- Browse **every G-code file you have, wherever it lives** — the Hub's own library and
  each printer's onboard storage, merged into **one list** with badges showing which
  machines hold a copy, **embedded model thumbnails**, and the **colors each job needs**.
- **Manage files where they sit**: rename or delete in the Hub library or on any
  printer's storage, and **copy files printer-to-printer** with live progress and a
  size-verified result — no re-slicing, no USB sticks.
- See **every machine's loaded colors and live status** at a glance, updated **in
  real time**: progress, screen-matching time remaining, and a **layer counter**
  tick the moment the printer reports them, not on a polling delay.
- **Change a loaded filament's color from the Hub** — tap a swatch on any idle machine
  and pick from common colors, type a hex code or a color name ("tan"), or open the
  full color picker. The touchscreen updates to match.
- **Push a job to any machine** — and optionally pre-map each color to the head you
  want it to print from, so the machine's mapping screen comes up already correct.
- Watch an **upload progress bar** while a file is sent, so a big push isn't a silent wait.
- **Pause, resume, or cancel** a running print from any card — and if a print errors,
  the card shows the **firmware's actual error message**, not just a red dot.
- **Skip a single object mid-print** from a tap-to-skip plate map — salvage the rest of a
  plate when one part fails instead of scrapping the whole bed.
- **Set the bed temperature** per machine, and get a warning chip when a printer's
  **storage runs low**.
- **Queue jobs "up next"** — build a shared print queue that survives Hub restarts,
  and reorder or remove entries with a tap.
- **Plan Full Spectrum mixes from any 3MF** — drop a multi-color project on the FS Mix
  Planner and get the exact filament blend recipes to print it on 4 toolheads, solved
  against the colors actually loaded on your machine.
- **Protect the Hub with a password** — optional single shared password with 30-day
  sessions, or hand auth to your reverse proxy (Authelia/Authentik supported).
- **Reach it from outside your network** — the Hub can run a Cloudflare tunnel for you:
  HTTPS end to end, no port forwarding, no router changes, and it **refuses to go
  public until the password gate is on**.
- See **lifetime farm stats** (total jobs, print hours, filament used) and per-printer
  **temperature sparklines and job history** in expandable panels.

It talks straight to each printer's built-in Moonraker API. Nothing is installed on the
printers, and nothing leaves your network unless you turn remote access on.

---

## New in 2.7 — the remote & files release

- **Secure remote access, managed by the Hub.** Open ⚙ Settings → Remote access and
  the Hub does the rest: it downloads the official Cloudflare `cloudflared` binary,
  runs it, watches its status, and shows your public HTTPS URL — **no port
  forwarding, no router configuration, no exposed ports** (the tunnel dials *out*).
  Two modes:
  - **Quick tunnel** — zero accounts. One click gets a random
    `https://….trycloudflare.com` URL that lives as long as the Hub does. Perfect
    for checking on a long print from anywhere.
  - **Named tunnel** — bring a free Cloudflare account and a domain, and the Hub runs
    a tunnel with a **stable hostname** you can bookmark and install as an app.

  **Security is not optional here:** the Hub flat-out refuses to start a tunnel until
  the password gate is enabled. (Proxy and forward-auth modes are refused too — a
  tunnel points straight at the Hub and would bypass your reverse proxy's login.)
  Secure first, public second.

![Remote access — Hub-managed Cloudflare tunnel status in Settings](docs/tunnel.png)
![The dashboard on a phone, over HTTPS, from anywhere](docs/remote-phone.png)

- **A real phone app, finally.** Served over the tunnel's HTTPS, your phone's
  **Add to Home Screen** now produces a true standalone install — full screen, own
  icon, no browser chrome.
- **One file explorer for the whole farm.** The file list now shows the Hub's library
  *and* every printer's onboard storage together. Badges on each row show exactly
  which machines hold a copy; files that exist only on a printer appear with a dashed
  edge and their own thumbnails (pulled from the printer's metadata). **Source filter
  pills** — Hub, U1, U2, … — let you scope the list to any machine with a tap, and
  they stack with the text filter.

![Unified file explorer — one list, badges for every copy, source filter pills](docs/explorer.png)

- **Manage files where they live.** Hover a library row for **rename / delete**;
  tap any printer badge to manage **that machine's copy**. Renaming a library file
  carries its queue entries and print history along with it. The guards are strict
  and loud: the Hub **never touches a file that is actively printing**, never
  silently overwrites, honors the printer's own read-only flags, and won't delete a
  file that's still in the print queue — every refusal tells you exactly why.

![Per-copy file actions — rename, delete, and send from any printer badge](docs/file-actions.png)

- **Copy files printer to printer.** Tap a badge → **Send to…** → pick a machine.
  The Hub streams the file from one printer straight to the other (a 400 MB file
  never touches RAM or your disk), shows live progress in place, then **re-reads the
  destination and verifies the byte count** before calling it done. If the name
  already exists on the target, the Hub refuses rather than overwrite — delete or
  rename the old copy first.

![Cross-printer transfer — done, size verified](docs/transfer.png)

- Fixed along the way: G-code thumbnails are now served from the cached path they
  were always meant to use (a leftover duplicate route was shadowing it).

---

## New in 2.6 — the access & mixing release

- **Print queue.** The Hub now answers "what prints next?" for the whole farm. An
  **Up next** list sits above the file browser: tap **+ Add to queue** on any job to
  line it up, bump entries up or down with the arrows as priorities change, and
  remove them with a tap. When a machine frees up, the next job is one tap from printing — no scrolling
  a big folder trying to remember what you promised whom. The queue lives on the Hub,
  so it's shared by everyone: line up tomorrow's work from the couch tonight and it's
  waiting on the shop computer in the morning, and it **survives Hub restarts**
  (`queue.json`). Starting a queued job checks it off the list automatically.

![Print queue — the Up next list beside a selected job with Add to queue](docs/queue.png)

- **FS Mix Planner** (🎨 in the top bar). Drop any multi-color 3MF — Bambu Studio and
  Orca-family projects both work — and the Hub extracts its palette, ranks colors by how
  many parts use them, and solves each one into the closest achievable blend of the
  filaments loaded on your printer. Every recipe comes with a ΔE quality grade, and
  colors that physically can't be mixed from your spools (true black, deep saturated
  tones) are **flagged as out of gamut instead of silently printing wrong** — the
  closest reachable match is shown so you know the tradeoff before wasting a print.
  Recipes are entered in your FS fork's Edit Mix dialog; the raw definition string is
  included for reference. The blend math was verified against the slicer's own Mix
  Effect preview.
- **Password protection.** The Hub now has an optional access gate: set a single shared
  password from ⚙ Settings → Manage access (or `/auth.html`) and every page and API
  call requires login, with sessions that last 30 days per device. Five wrong guesses
  locks the door for 15 minutes. Nothing changes until you opt in — existing installs
  stay open.
- **Reverse-proxy friendly.** Already running auth in front of the Hub? **Proxy mode**
  turns the built-in gate off on purpose, and **forward-auth mode** trusts the identity
  header your Authelia/Authentik setup injects — no double login.
- **Official spools handled honestly.** Snapmaker's RFID spools carry their color on
  the tag, and firmware refuses to override it — so the Hub no longer offers the color
  picker on official spools (hover the swatch to see why), and explains the lock in
  plain language instead of surfacing a firmware error.
- Quality of life: the browser tab finally has a favicon.

![FS Mix Planner — spool colors, 3MF palette extraction, and blend recipes](docs/fs-mixer.png)

---

## New in 2.5 — the realtime release

- **Live dashboard.** The Hub now holds a websocket open to every printer and streams
  changes to your browser the moment they happen. Progress, ETA, layer counts, and
  state changes appear in well under a second. If a socket or the stream drops, the
  Hub falls back to classic polling automatically — it never gets worse, only faster.
- **Screen-matching progress and time remaining.** The Hub computes progress exactly
  the way the U1's touchscreen does (header-corrected byte progress), so the card and
  the screen finally agree — verified to within 1% and one minute on live prints.
- **Filament color control.** The Hub speaks the same firmware command the touchscreen
  uses (`SET_PRINT_FILAMENT_CONFIG`), then re-reads the printer to confirm the change
  landed before showing success. Guard rails match the touchscreen: idle printers and
  loaded slots only.
- **G-code thumbnails.** Snapmaker Orca embeds model previews in every sliced file;
  the Hub extracts them for the file browser and shows the active job's preview on
  each printing card.
- **Phone home-screen app.** Add the Hub to your phone's home screen for one-tap
  access. (As of 2.7, serving over the tunnel's HTTPS upgrades this to a full
  standalone install.)
- Quality of life: multi-color/gradient spool swatches (ready for RFID dual-color
  filament), "chamber" labeling, farm + per-printer statistics panels, active
  filename on cards, and a low-disk warning chip.

---

## Full Spectrum aware (since 2.0)

The U1's **Full Spectrum** workflow alternates a few physical filaments layer-by-layer to
produce many more apparent colors. The hub understands it:

- **Detects Full Spectrum files** from either fork family — ratdoux FullSpectrum and the
  Neotko feature pack — so it never mistakes a 16-color FS job for one that "needs more than
  the U1's 4 heads." (The Neotko build reports as stock Snapmaker Orca, so detection is by
  the file's config fingerprint, not the slicer name.)
- **Visualizes the mixed colors.** Select an FS job and the hub decodes its color recipes,
  showing every blended color with a preview swatch, the physical filaments it mixes, and the
  ratio — so you can see what your loaded filaments will actually produce. (The swatches are
  an on-screen approximation of the optical blend; the print is the final word.)

Plus, across every job: **last-printed date** for every file, **per-color filament
usage** (grams) on the selected job, cosmetic **T1–T4 head labels**, and a **scrolling
file list** that keeps the page tidy with big folders.

---

## Download (no Node.js needed)

Grab the build for your OS from the **[Releases](../../releases)** page, put it in
its own folder, and run it — a browser opens to the dashboard.

- **Windows** (`U1-Print-Hub-Windows-x64.exe`): SmartScreen may warn "unknown publisher"
  (the app isn't code-signed). Click **More info -> Run anyway**.
- **macOS** (`U1-Print-Hub-macOS-AppleSilicon` / `-Intel`): right-click -> **Open**
  the first time to clear Gatekeeper, or run `xattr -dr com.apple.quarantine <file>` once.
  You may need to `chmod +x` it.
- **Linux** (`U1-Print-Hub-Linux-x64`): `chmod +x` then run it.

`config.json` and a `gcode/` folder are created next to the executable on first run.
Use **Settings** in the page to add your printers.

> **Already running on port 4545?** Only one copy can use the port. If a launch flashes
> and closes, something else (often a second copy) already has 4545 — close it first.

---

## Run with Docker (Raspberry Pi / NAS / homelab)

For always-on hosts, run the hub in a container. It serves the same dashboard.

```bash
git clone https://github.com/dlgambill/u1hub.git
cd u1hub
cp config.example.json config.json     # a writable config the hub persists to
mkdir -p gcode                          # point your slicer here, or mount your real folder
docker compose up -d
```

Then open `http://<this-host-ip>:4545`.

**About auto-discovery:** the "Discover on network" scan only works with **host
networking**, which `docker-compose.yml` enables by default (Linux hosts). On Docker
Desktop (macOS/Windows) host networking behaves differently — comment out
`network_mode: host`, uncomment the `ports:` block, and just **add printers by IP** in
Settings (that always works, container or not).

Edit the `volumes` in `docker-compose.yml` to point at your real Orca output folder.

---

## Run from source (developers)

### 1. Install

You need **Node.js 22 or newer** (the realtime layer uses Node's built-in WebSocket
client) — get the **LTS** build from https://nodejs.org and run the installer
(defaults are fine). Then:

1. Unzip this folder somewhere permanent, e.g. `C:\u1-print-hub`.
2. Start it:
   - **Windows:** double-click **`start-windows.bat`**
   - **Mac / Linux:** run **`./start-mac-linux.sh`** in a terminal

The first launch installs what it needs (takes a minute) and then opens
**http://localhost:4545** in your browser.

> **Use it from your phone:** find the IP of the computer running the hub and open
> `http://THAT-IP:4545` on your phone — e.g. `http://192.168.1.20:4545`. Then use your
> browser's **Add to Home Screen** for a one-tap app icon. Keep the hub running on a
> computer that stays on (or set the launcher to run at startup). Away from home,
> turn on **Remote access** (below) and use the tunnel URL instead.

### 2. First-time setup (all in the browser)

The **Settings** panel opens automatically the first time. Three steps:

1. **Add your printers.** Click **Discover on network** to scan your LAN and list any
   Snapmaker U1s it finds — click **Add** on each. (Or **Add manually** and type an IP.)
2. **Set your G-code folder.** Point it at the folder Snapmaker Orca saves sliced files to.
3. **Save.**

Reopen Settings anytime with the gear button.

### 3. Optional: remote access

1. **Set a password first** — ⚙ Settings → Manage access. The tunnel will not start
   without it, on purpose.
2. Open ⚙ Settings → **Remote access**, click **Download cloudflared** (one time),
   pick **Quick tunnel**, and hit **Start**. Your public HTTPS URL appears when the
   tunnel connects — open it from anywhere, log in, and you're on your dashboard.
3. Want a **permanent address**? Create a (free) Cloudflare account, add a domain,
   create a tunnel in the Zero Trust dashboard pointing at
   `http://localhost:4545`, and paste its token into **Named tunnel** mode. Your
   hostname now survives Hub restarts — bookmark it, install it, print from the beach.

---

## Using it

- **Pick a file** from the left to see the colors it needs. Files show a **thumbnail**
  and their **last-printed date** once they've run, and the selected job lists
  **per-color gram usage**. If it's a **Full Spectrum** job, a panel decodes and
  previews all its mixed colors and recipes.
- **The list is the whole farm.** Badges under a file show every machine that has a
  copy; dashed rows live only on a printer. The **source pills** under the sort menu
  scope the list — untick **Hub** to see only printer storage, or tick a single
  machine to audit exactly what's on it. The text filter stacks on top.
- **Manage any copy.** Hover a library row for **✎ rename** and **🗑 delete** (rename
  keeps its queue spot and print history). Tap a **printer badge** to open that
  copy's actions: rename, delete, or **→ Send to…** another machine — with live
  progress and a size-verified finish. Every destructive action asks first and names
  exactly which copy it will touch; every refusal (file is printing, name exists,
  file is queued) says so in plain words.
- **Queue work with "Up next."** Tap **+ Add to queue** on a selected job to line it
  up. The queue sits above the file list; use the arrows to reprioritize and **✕** to
  remove. Starting a queued file (from any machine) clears it from the list — so the
  queue always shows what's actually left to run.
- **Each machine card** shows its four heads (**T1–T4**) with the colors currently loaded,
  plus status and bed temp — and, while printing, a **live progress bar, layer counter,
  screen-matching time remaining, and the job's thumbnail**. When a job is selected, you
  get a per-color **"Send each color from"** picker (defaulted to the best match) and
  **Upload** / **Print** buttons.
- **Tap a head's color swatch** on an idle machine to change that filament's recorded
  color: pick from the grid, type a hex code or CSS color name, or open the full
  picker. The Hub confirms the printer accepted the change before showing success.
- **Press Print** to send to that machine; a progress bar tracks the upload, then the
  print starts with your color mapping already applied.
- **While a machine is printing,** the card shows **Pause / Resume** and **Cancel**, plus
  a **Plate** button that opens a live map of the bed. Tap any object to **skip** it — the
  rest of the plate keeps printing. (Skipping is irreversible.) The map's bottom edge is
  the **front** of the bed.
- The **▁▂▅ button** on each card opens live temperature sparklines, lifetime totals,
  and the last ten jobs. **Farm stats** at the bottom aggregates the whole fleet.

### Keep your printer IPs from changing

Open **Network inventory** at the bottom — it lists every machine's **MAC address**.
In your router, add a **DHCP reservation** binding each MAC to its current IP. After that,
addresses never move and you won't have to touch anything.

---

## Notes

- **Toolhead mapping** is set the same way Snapmaker Orca does it: the hub uploads the
  file, sends the `SET_PRINT_EXTRUDER_MAP` macros for your chosen head assignment, then
  starts the print. The dropdowns pick which physical head prints each color.
- **Per-head colors** are read from Moonraker's `print_task_config` object and written
  with the firmware's own `SET_PRINT_FILAMENT_CONFIG` command — the same one the
  touchscreen issues. The live plate map and skip feature use the standard Klipper
  `exclude_object` module.
- **File management and transfers** use Moonraker's standard file API (`upload`,
  `move`, `delete`) — verified against real U1 firmware before shipping. Transfers
  stream through the Hub with backpressure, so file size is limited by the printers'
  storage, not the Hub's memory.
- **Progress and time remaining** use the touchscreen's own formula: header-corrected
  byte progress from `virtual_sdcard` plus the slicer's estimated time, so the Hub and
  the machine's screen agree. Falls back to a self-correcting estimate when file
  metadata isn't available.
- **Realtime** uses one websocket per printer plus a server-sent-events stream to the
  browser; both fall back to plain HTTP polling automatically if anything is in the way.
- **Treat the hub like the printers it controls.** Turn on the password gate
  (⚙ Settings → Manage access) if anyone you don't fully trust can reach your network.
  For access from outside, **use the built-in tunnel and nothing else** — it's HTTPS
  end to end and it requires the password gate before it will start. **Never forward a
  router port to the Hub**: on the LAN it still speaks plain HTTP, and a password sent
  over unencrypted HTTP is only as private as the network it crosses. The tunnel
  exists precisely so you never have to do that.

---

## Found this useful?

**Buy me a beer** -> https://venmo.com/u/dgambill  (Venmo @dgambill). No pressure, all appreciated.

## License

MIT — see `LICENSE`. Free to use, change, and share.

---

## Diagnostic: capture how Orca sends the toolhead mapping

`capture-proxy.js` sits between Snapmaker Orca and ONE real printer, forwards
everything (so Orca works normally), and logs every request — so you can see the
exact call that carries the head mapping.

1. Find the IP of the machine running this (Windows: `ipconfig`; Mac/Linux: `ifconfig`).
2. Run, pointing at the printer you're testing:
   `node capture-proxy.js http://<printer-ip> 7125`
3. In Orca, edit that printer's connection host to `http://<this-machine-ip>:7125`
   (keep type = Klipper/Moonraker). Slice, set your toolhead mapping, hit Send.
4. Everything lands in `capture-<timestamp>.log` — the upload and any mapping call
   will be in there in plain text.
5. When done, point Orca's host back at the real printer IP.

---

## For maintainers: building & releasing

Single-file executables are built by [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg)
on **native runners** (each OS builds on its own runner — no cross-compiling). To cut a
release, bump the version in `package.json` and the `VERSION` constants in `server.js`
and `public/index.html`, then tag and push:

```
git tag v2.7.0
git push origin v2.7.0
```

`.github/workflows/release.yml` builds Linux, Windows, and Apple-Silicon macOS binaries
and publishes them to a GitHub Release. The Intel-Mac build is a **best-effort** job:
GitHub's free `macos-13` runners are often unavailable, so it must not block the release —
it attaches its binary afterward if/when a runner frees up. To build locally instead:
`npm install && npm run build` (output in `dist/`).
