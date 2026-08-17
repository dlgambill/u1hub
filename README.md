# U1 Print Hub

![U1 Print Hub dashboard — farm view with live prints and the filament color picker](docs/dashboard.png)

A small local dashboard for a farm of **Snapmaker U1** printers — and, in **beta**,
any other Klipper/Moonraker printer you run beside them. From your phone or
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
- **Peek inside any machine** — open its **chamber camera** as an on-demand live view
  from the card, and close it again to keep data use down.
- **Change a loaded filament's color from the Hub** — tap a swatch on any idle machine
  and pick from common colors, type a hex code or a color name ("tan"), or open the
  full color picker. The touchscreen updates to match.
- **Push a job to any machine** — and optionally pre-map each color to the head you
  want it to print from, so the machine's mapping screen comes up already correct.
- **Ask "what can I print right now?"** — **Spool Match** reads each printer's loaded
  colors and lists the library jobs those colors can already produce, best match first,
  one tap from printing.
- Watch an **upload progress bar** while a file is sent, so a big push isn't a silent wait.
- **Pause, resume, or cancel** a running print from any card — and if a print errors,
  the card shows the **firmware's actual error message**, not just a red dot.
- **Skip a single object mid-print** from a tap-to-skip plate map — salvage the rest of a
  plate when one part fails instead of scrapping the whole bed.
- **Set the bed temperature** per machine, and get a warning chip when a printer's
  **storage runs low**.
- **Power a printer on or off** through a smart plug — with live wattage on metered
  plugs, and a guard that refuses to cut power to a machine that's mid-print.
- **Queue jobs "up next"** — build a shared print queue that survives Hub restarts,
  and reorder or remove entries with a tap.
- **Plan Full Spectrum mixes from any 3MF** — drop a multi-color project on the FS Mix
  Planner and get the exact filament blend recipes to print it on 4 toolheads, solved
  against the colors actually loaded on your machine — or ask it **which 4 spools from
  your shelf** to load in the first place.
- **Give every spool an identity** — scan a spool's **RFID tag with your phone** (or a
  printed **QR label**) and the Hub knows its brand, material, color — even dual-color
  silks and gradients — and temps forever after. Scan again to **load it into a printer
  slot in one motion**, head color set to match.
- **Track what's loaded where** — every bound spool shows which machine and slot it's
  physically sitting in, fleet-wide.
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

## New in 2.9 — the spools & beta-fleet release

- **A spool registry you scan with your phone.** Stick an **NTAG RFID sticker** on a
  spool (or use the RFID tag many spools already ship with — the Hub reads the tag's
  **serial number only**, nothing proprietary is decoded) and scan it with **Android
  Chrome** over the Hub's HTTPS tunnel. An unknown tag asks **once** what's on the
  spool — search ~2,266 **colorimeter-measured swatches** from FilamentColors.xyz,
  sample the color already loaded on a head, or describe it yourself — then resolves
  **instantly forever after**. No phone NFC? **Print QR labels** from the Hub and scan
  those with any camera, iPhone included. One spool can carry **both** its vendor tag
  and a Hub sticker — attach the second tag to the same identity with a tap, no
  duplicates.

![The Spools tab — bound spools with brand, material, temps, tags, and where each one is loaded](docs/spools.png)
![A new tag being bound — attach it to a spool you already have, search the swatch library, or describe it yourself](docs/bind-panel.png)

- **Full identities, including the weird filaments.** The describe-it-yourself form
  takes manufacturer, **material type** (PLA/PETG/ASA/…), **variant** (Matte, Silk,
  Glow, CF…), print temps — and real **multi-color support**: dual- and tri-color
  silks render as segmented swatches, gradients blend smoothly, everywhere the spool
  appears. (Multi-color spools are automatically excluded from mix recipes — their
  extruded color depends on position, so they'd poison a blend.)

- **Scan-to-load: the killer loop.** Tap a head's color swatch on any printer card and
  the picker now has **“📶 Scan spool → load here.”** Hold the spool's tag to your
  phone: the Hub records **that spool is now in that slot** and pushes its measured
  color onto the head in one motion — Spool Match instantly treats it like an official
  RFID roll. Works the other direction too: scan a spool in the Spools tab and pick a
  printer + slot from its card. A brand-new tag scanned at a printer bounces to the
  bind panel and then **loads itself into the slot you started from**. Loadout state
  survives restarts; forgetting a spool unloads it everywhere.

![Scan-to-load — the head color picker with Scan spool, one tap from tag to loaded](docs/scan-to-load.png)
![A scanned spool's card — load it into any printer and slot, head color set to match](docs/spool-scan.png)

- **“What should I load?”** The FS Mix Planner's inverse solve: drop a 3MF and the
  **base-set recommender** ranks 4-spool sets **from your bound-spool shelf** by
  worst-case ΔE across every color the print needs — so the recommendation names your
  actual physical rolls, not theoretical colors. An ideal-CMYW benchmark row shows how
  close your shelf gets to the ceiling.

![The recommender — ranked 4-spool sets from your own shelf, with per-target ΔE](docs/recommender.png)

- **Orca-alignment for FS mixes.** The Hub's mix serialization is byte-exact against
  the FS fork both directions — and a real bug got fixed on the way: **pair-style mix
  definitions in sliced G-code were silently missing** from the FS preview. A
  reconciliation view shows the fork's decoded mixes next to the Hub's predictions,
  side by side.

- **Other printers, in beta.** Add a **printer type** in Settings (it gets its own
  folder, accent color, and switcher tab — U1 keeps its flat base folder), then add any
  Klipper/Moonraker machine into it. The Hub detects capabilities **per printer** —
  single-extruder machines get a clean single-head card, and a **class guard** refuses
  multi-color jobs dropped on machines that can't print them. Non-U1 types wear a
  **BETA** chip: they're fully harness-verified against mock printers, and real-hardware
  reports are how they graduate.

![Printer types in Settings — U1 grandfathered, new types in beta with their own folders and accents](docs/types-beta.png)

- **Diagnostics bundle — beta reports that fix things.** ⚙ Settings → **Download
  diagnostics** produces one JSON: Hub version, printer types + **detected**
  capabilities, the recent in-memory Hub log, and the tail of each printer's
  `klippy.log`/`moonraker.log`. **IPs are replaced with aliases and tokens are
  scrubbed before the file is written**; auth and tunnel secrets are never read at
  all. Nothing is ever sent anywhere — you review the file and attach it to a [GitHub
  issue](https://github.com/dlgambill/u1hub/issues/new/choose) (there's a template that asks for it). The Hub still has **zero telemetry**.

![Download diagnostics — one sanitized JSON for bug reports, generated only when you ask](docs/diagnostics.png)

- **A UI worth using on a phone.** Higher-contrast theme (panels lift off a darker
  chassis, brighter text, punchier status colors), a **sticky nav bar** so the view
  tabs are always one tap away, bottom-sheet modals, 44 px touch targets, and inputs
  sized so **iOS stops zooming the page** on every field. Two long-standing bugs died
  in the process: file-row actions were **unreachable on touchscreens** (they only
  appeared on hover), and taps sometimes needed two or three tries because the live
  fleet stream could **rebuild the page mid-tap** — re-renders now wait for your
  finger to lift, and identical updates don't redraw at all.

- **Docker fix.** The image now ships every module it needs (Issue #1) — `docker
  compose up -d` on a Pi or NAS works out of the box.

---

## New in 2.8 — the power & cameras release

- **Turn printers on and off from the Hub.** Put a printer behind a smart plug and its
  card gains a **power row** — an On/Off toggle, and on metered plugs the **live wattage**
  it's drawing right now, so you can tell a working machine from an idle one at a glance.
  **The Off button is hard-blocked while a printer is printing or paused:** the Hub checks
  live print state before it will cut power and refuses if it can't confirm the machine is
  idle — you can't kill a running job from the dashboard by accident. Power-*on* is always
  allowed, so you can wake an offline printer straight from its tile. Two plug types are
  supported: **Shelly** (metered, reports live watts) and a **generic URL** driver that
  fires any on/off HTTP endpoint — Tasmota, ESPHome, Home Assistant, or a DIY plug.
  Configure it per printer in `config.json`; the **dashboard only ever sees whether a
  printer has a plug and its live draw** — never the plug's address.

![Smart power control — live wattage on the card, with Off locked out while the printer runs](docs/power.png)

- **Spool Match — "what can I print right now?"** A new **Spool Match** tab turns the usual
  question around: instead of picking a file and hunting for a machine with the right colors
  loaded, it reads **each printer's currently loaded colors** and shows you every library job
  those colors can already print. Files are ranked **best match first** — an **exact** badge
  when every color lines up, a percentage when it's partial — and a printer's row expands to
  the matching files with thumbnails and a one-tap **Print**. Color closeness is judged in
  perceptual (CIEDE2000) space, scored against a cached palette index of your whole library.

![Spool Match — every printer's loaded colors and how many library files they can print](docs/spool-match.png)
![A printer expanded to its matching files, ranked best-first, each one tap from printing](docs/spool-match-expanded.png)

- **Cameras, on demand.** Every printer card can open its **chamber camera** as a live
  view — but it no longer streams by default. Tap **Live view** to start the feed, **✕** to
  close it. That keeps cards clean and, when you're watching remotely over the tunnel, stops
  a wall of cameras from quietly eating your cellular data. The choice is remembered **per
  device**, so your phone can stay on-demand while the shop desktop runs always-on — flip
  **Auto-start on every card** in Settings to restore the old behavior on whichever device
  you're using.

![Chamber camera — tap Live view to open the feed on demand](docs/cameras.png)
![The live chamber view, expanded on a printing card](docs/camera-live.png)
![Per-device camera preference — Auto-start on every card, in Settings](docs/camera-settings.png)

- **Know which official spools are loaded.** Snapmaker's RFID spools carry their identity on
  the tag, so official rolls now show a small **🔒 vendor · material** line under the color
  swatch, with the full profile in the tooltip. Third-party and blank heads are unchanged and
  stay color-only, so the extra detail appears only where the printer actually knows what's
  loaded. It's read from the same `print_task_config` the color swatch already uses, and it
  lays the groundwork for the spool registry and scan-to-apply work coming next.

![An official Snapmaker spool showing its vendor and material under the swatch](docs/spool-identity.png)

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

- **App-like on your phone — no app store, nothing to download.** The Hub is a web
  dashboard, so your phone just opens it in a browser. Served over the tunnel's
  HTTPS, tapping **Add to Home Screen** now produces a true standalone install —
  full screen, own icon, no browser chrome.
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

> **There is no phone app to download.** The Hub runs on a computer (Windows, Mac,
> or Linux) that stays on; your phone opens it in a browser at that computer's
> address — and can pin it to the home screen for an app-like icon. The downloads
> below are for the **computer**, not your phone.

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

### 4. Optional: smart plugs (power control)

Wire a printer's power through a smart plug and the Hub can switch it right from that
printer's card. Set it up in **⚙ Settings**: each printer row has a **Smart plug**
dropdown — pick **Shelly** (metered, shows live watts) or **Generic on/off URL**, fill in
the address, and **Save**. The Hub writes it into `config.json` for you; choose **None**
and save to remove it. Two types are supported:

- **Shelly** — a Shelly plug on your LAN. The card gets an On/Off toggle **and the live
  wattage** the printer is drawing. Give it the plug's IP:

  ```json
  { "name": "U1", "url": "http://192.168.1.50",
    "plug": { "type": "shelly", "ip": "192.168.1.60" } }
  ```

- **Generic URL** — anything that switches over HTTP (Tasmota, ESPHome, Home Assistant,
  a DIY relay). You supply the on and off URLs; no wattage, just control:

  ```json
  { "name": "U2", "url": "http://192.168.1.51",
    "plug": { "type": "url",
              "on":  "http://192.168.1.61/on",
              "off": "http://192.168.1.61/off" } }
  ```

Those blocks are what the Hub writes; you can also hand-edit `config.json` directly if you
prefer — the `plug` sits **alongside** each printer's existing `name`/`url` and doesn't
replace anything.

Give the plug a **static IP** — set it on the plug itself, or as a DHCP reservation — so
its address doesn't drift. The plug's IP lives in `config.json` on the machine running the
Hub; the **dashboard never sees it** (only Settings, behind your password, reads it back so
you can edit it).

**Safety:** the **Off** button is refused while that printer is printing or paused. The
Hub confirms the machine is idle before it will cut power, and fails safe (leaves it on)
if it can't tell. Powering **on** is always allowed, so you can wake an offline printer
from its tile.

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
- **Spools tab — give your filament identities.** Scanning needs **Android Chrome over
  HTTPS** (open the Hub via its tunnel URL — Web NFC won't run on plain `http://`).
  Scan a tag: unknown tags ask what's on the spool once; known tags show the identity
  card with **Load to printer**. No NFC? **Print QR labels** (🏷 on any spool row) and
  scan with any phone camera, iPhone included. Tag policy that works well: RFID
  stickers for the durable core spools, QR labels for everything else, nothing on
  truly disposable rolls — and when a spool dies, **re-bind** its tag to the
  replacement roll instead of re-sticking.
- **Loading filament?** Tap the head's swatch on the printer card → **Scan spool →
  load here** → touch the tag. Loadout recorded, head color set, done. The spool's row
  in the Spools tab shows **▸ where it lives** from then on.
- **Adding a non-U1 printer (beta):** ⚙ Settings → **Printer types** → add a type
  (e.g. “SV06”), then add the printer into it by IP (`http://<ip>:7125` for stock
  Moonraker — U1s use port 80, which Discover already knows). The card adapts to what
  the printer actually reports. If anything misbehaves, **Download diagnostics** and
  open a [GitHub issue](https://github.com/dlgambill/u1hub/issues/new/choose) with the file attached — that's how beta types get verified.

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
- **Spool tags are serial numbers, nothing more.** The registry keys on a tag's freely
  readable UID — no vendor payloads are decoded, ever. Identities live in `spools.json`
  and loadout in `slots.json`, next to your config; QR labels encode an opaque
  `u1spool:<id>` pointer back to them.
- **Treat the hub like the printers it controls.** Turn on the password gate
  (⚙ Settings → Manage access) if anyone you don't fully trust can reach your network.
  For access from outside, **use the built-in tunnel and nothing else** — it's HTTPS
  end to end and it requires the password gate before it will start. **Never forward a
  router port to the Hub**: on the LAN it still speaks plain HTTP, and a password sent
  over unencrypted HTTP is only as private as the network it crosses. The tunnel
  exists precisely so you never have to do that.

---

## Credits

- **[FilamentColors.xyz](https://filamentcolors.xyz)** (© Joe Kaufeld, MIT) — the
  bundled library of colorimeter-measured filament swatches that makes search-to-bind
  and honest ΔE math possible.
- **jsQR** (Apache-2.0) and **qrcode-generator** (MIT) — vendored for QR label
  scanning and generation, so the iPhone path works with no network dependency.

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
git tag v2.9.0
git push origin v2.9.0
```

`.github/workflows/release.yml` builds Linux, Windows, and Apple-Silicon macOS binaries
and publishes them to a GitHub Release. The Intel-Mac build is a **best-effort** job:
GitHub's free `macos-13` runners are often unavailable, so it must not block the release —
it attaches its binary afterward if/when a runner frees up. To build locally instead:
`npm install && npm run build` (output in `dist/`).
