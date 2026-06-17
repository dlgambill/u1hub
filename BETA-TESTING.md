# Beta Testing — U1 Print Hub

Thanks for helping test! This is early software that **controls real printers**, so
please read the safety note, and report anything that seems off — even small things.

## Read first (safety)

- It's **LAN-only and has no password.** Run it on your home/shop network. Do **not**
  expose it to the internet or forward a port to it.
- It can **start prints.** While testing, don't leave a print running unattended — a
  printer is a ~300°C heat source. Stay nearby the first several times.
- You'll need at least one Snapmaker U1 reachable on your network.

## Setup

1. Download the build for your OS from **[Releases](../../releases)** (or run from source
   with Node 18+).
2. Run it — a browser should open to the dashboard (default `http://localhost:4545`).
3. The **Settings** panel opens on first run: click **Discover on network** (or add your
   printer's IP manually), set your G-code folder, and **Save**.
4. Check the **version badge** (top-right) is green and shows the current version.

## What to test

Try each of these and note what happened — the starred ones are where I most need eyes.

1. **Discovery** — Did *Discover on network* find your U1(s)? If not, did adding by IP work?
2. **Opening files** — Click a few of your real sliced files. Do the **right colors** show
   as needed? In particular, a job that deliberately leaves a palette color unused —
   is that color correctly left out? Does the file open quickly?
3. **Fleet view** — Do your machines show the correct loaded colors, status, and bed temp?
4. ⭐ **Toolhead mapping** — Pick a multicolor job, set each color to a specific head with
   the dropdowns, and Print. **Did each color print from the head you chose?**
   - **2-color and 3-color jobs especially.** The 4-color case is confirmed; partial-color
     jobs are not yet. A color printing from the wrong head is the #1 thing to report.
5. **Bed temp** — Use the **Set** / **Off** buttons on a machine card. Did the bed respond?
6. **Plain send** — Upload / Print a single-color job with no mapping. Works?

## Reporting a bug

Open an issue: **https://github.com/dlgambill/u1hub/issues**

Please include:

```
Version badge (top-right):
OS + how you ran it (Windows .exe / macOS / Linux / from source):
Printer model + how many printers:
What you did (step by step):
What happened:
What you expected:
```

For **mapping** problems, this detail is gold:

```
Job: how many colors (and the file, if you can share it):
Your mapping (which color → which head, T0–T3):
What actually printed (which color came out of which head):
```

If a terminal/console window showed any errors, paste those too.

## Quick gut-checks before "it doesn't work"

- **Version badge green?** A red badge means an old server is still running — restart it.
- **Did you restart** after updating?
- **Is the printer reachable?** Open `http://<printer-ip>:7125/printer/info` in a browser —
  it should return JSON.

Thanks for testing — every report genuinely helps. 🍺
