# U1 Print Hub

One dashboard for a whole farm of Snapmaker U1 printers. Other Klipper printers
can join in too (that part is in beta).

![The dashboard: every printer, every color, every print, on one page](docs/dashboard.png)

You run the Hub on a computer that stays on. Your phone, or any browser, opens
it like a web page. From there you can see every machine at once, send prints,
watch cameras, plan your printing week, and know what filament to buy before
you run out.

Nothing gets installed on the printers. The Hub talks to the software they
already run, and nothing leaves your network unless you turn remote access on,
ask for a phone notification, or press the AI pre-flight button with your own
key in place.

---

## What it does

**See the whole farm at a glance.** Every printer gets a card with its live
status, progress, loaded colors, camera, and bed temperature. A print that
paused or failed says why, in the firmware's own words, so you know whether to
walk over. A printer that is down for maintenance says so right on the card,
and the scheduler routes work around it until you bring it back.

**Open any printer's own control page in one click.** Click a printer's name
and its full Klipper interface (Fluidd) opens, no typing IP addresses. On your
network it opens the printer directly, so its live data and controls work
exactly as they do when you visit the printer on its own.

![A printer's own Fluidd page, one click from the dashboard](docs/klipper-proxy.png)

**Send prints without walking over.** Pick a file, see the colors it needs,
choose which head prints which color, and push it to any idle machine. Files
live in one merged list: the Hub's library plus whatever is stored on each
printer, with thumbnails.

**Plan your whole printing day.** The Dispatch tab schedules your queue across
every printer, inside the hours you are actually home to swap plates. It flags
jobs that want the same spool at the same time, lets you push a job back a
place, and adopts prints that are already running.

![Dispatch: the week's prints laid out across the fleet](docs/dispatch.png)

**Know what to buy.** The Resources tab reads every scheduled file, adds up
the filament by color, compares it to the spools you own, and shows what you
are short. Every row gets a Replenish on Amazon button that searches for that
exact filament.

![Resources: filament needed vs. what you have, shortfall first](docs/resources.png)

**Give every spool an identity.** Scan a spool's RFID tag with your phone, or
print a QR label for rolls that have no tag. The Hub remembers the brand,
color, and temps, tracks which machine each spool is loaded in, and tracks
grams left and price per roll. When a print finishes, the grams each head used
come off the roll that was in it, with the cost of that print at the price you
paid, and an Undo if it got one wrong. Already keep your rolls in
[Spoolman](https://github.com/Donkie/Spoolman)? Import them in one click; the
Hub reads Spoolman and never writes to it.

![Spools: every roll you own, where it is, and what is left on it](docs/spools-inventory.png)

**A second pair of eyes before you print.** With your own Anthropic API key
in Settings, an AI pre-flight button on the job card has Claude read the
slicer settings baked into the file and compare them with what is loaded in
the printer you picked: wrong material or temperature for a head, an empty
head a color needs, a missing prime tower. GO, CHECK or STOP, and why. Nothing
is sent until you press the button, never the gcode itself, and a review costs
about a cent.

**Let your phone tell you.** Settings can send push notifications through
[ntfy](https://ntfy.sh) (free, no account) when a print finishes, a printer
pauses (with the reason), errors, or stops answering. Pick the events you want;
one box turns it all off.

**Ask "what can I print right now?"** The Match tab reads the colors loaded
on each printer and lists the library files those colors can already produce,
best match first, one tap from printing.

![Match: jobs your loaded colors can print right now](docs/spool-match.png)

**Use it from your phone.** The whole thing is built for a phone screen. Add
it to your home screen and it behaves like an app.

<img src="docs/remote-phone.png" width="300" alt="The dashboard on a phone">

There is more in the drawers: smart plug power control with a guard that
refuses to cut power mid-print, a Full Spectrum mix planner, per-printer
stats and temperature graphs, skip-an-object mid-print, a shared print queue,
and printable QR spool labels. The [long version](docs/CHANGELOG.md) covers
everything in detail, release by release.

---

## Getting started

**There is no phone app to install.** The Hub runs on a computer (Windows,
Mac, or Linux) that stays on. Your phone just opens it in a browser.

**Easiest: download a build.** Grab the one for your system from the
[Releases](../../releases) page, put it in its own folder, and run it. A
browser opens to the dashboard, and Settings walks you through adding your
printers.

A few first-run notes:

- Windows may warn about an unknown publisher. Click More info, then Run anyway.
- On a Mac, right-click the file and choose Open the first time.
- On Linux, `chmod +x` the file, then run it.
- Only one copy can run at a time. If it flashes and closes, another copy
  already has port 4545.

**From your phone:** open `http://THE-COMPUTER'S-IP:4545`, then use your
browser's Add to Home Screen.

**Docker, for a Pi or NAS:**

```bash
git clone https://github.com/dlgambill/u1hub.git
cd u1hub
mkdir -p data gcode
docker compose up -d
```

Everything the Hub remembers (printers, password, tunnel, spools, schedule)
lives in `./data` on the host, so upgrading is `git pull` and
`docker compose up -d --build` with nothing to redo. If you set up with the
older compose file, which only kept `config.json`, move that `config.json`
into `./data`, and copy your old container's `spools.json`, `slots.json`,
`dispatch.json`, `auth.json` and `tunnel.json` in beside it once
(`docker cp u1-print-hub:/app/spools.json data/` and so on).

**From source:** install Node.js 22 or newer, then run `start-windows.bat` or
`./start-mac-linux.sh`. First launch installs what it needs and opens the page.

---

## Using it away from home

Two switches in the Hub, no router changes:

1. Set a password (Settings). The Hub refuses to go public without one.
2. Turn on the tunnel (Settings). The Hub sets up a free Cloudflare tunnel
   and gives you an HTTPS address that works from anywhere.

Everything the Hub itself shows works remotely this way: the fleet, sending
prints, cameras, spools, and scheduling. The printers' own Klipper pages are
best used on your own network; opening them from outside can depend on your
network setup.

---

## The honest fine print

**Amazon links.** The Replenish on Amazon buttons carry an affiliate tag, so
the creator of this software earns a small commission if you buy through one,
at no extra cost to you. This is disclosed on the page itself, and there is a
checkbox in Settings to turn it off. Off means off: the links still work, they
just carry no tag.

**Update checks.** Once a day the Hub fetches one small public file to see if
a newer version exists. It sends nothing about you or your setup. One checkbox
turns it off, and off means no request is made at all.

**In-app slicing is not ready.** The checkbox for it ships off, and turning it
on warns you first. If you would like to help finish it, fork away.

**Other printer brands are beta.** The printer types feature works against
stock Klipper and Moonraker in testing. If yours misbehaves, use Download
diagnostics in Settings and attach the file to a
[GitHub issue](https://github.com/dlgambill/u1hub/issues/new/choose).

---

## Problems?

Open Settings, click Download diagnostics, and attach the file to a
[GitHub issue](https://github.com/dlgambill/u1hub/issues/new/choose). The file
is yours to review before you send it.

## License

MIT. See `LICENSE`. Free to use, change, and share.
