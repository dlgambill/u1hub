# U1 Print Hub

A small local dashboard for a farm of **Snapmaker U1** printers. From your phone or
any browser on the same network you can:

- Browse a folder of sliced G-code and see the **colors each job needs**.
- See **every machine's loaded colors and live status** (idle / printing %) at a glance.
- **Push a job to any machine** — and optionally pre-map each color to the head you
  want it to print from, so the machine's mapping screen comes up already correct.

It talks straight to each printer's built-in Moonraker API. Nothing leaves your network.

---

## Download (no Node.js needed)

Grab the build for your OS from the **[Releases](../../releases)** page, put it in
its own folder, and run it — a browser opens to the dashboard.

- **Windows** (`U1-Print-Hub-Windows-x64.exe`): Windows may warn "unknown publisher"
  (the app isn't code-signed). Click **More info → Run anyway**.
- **macOS** (`U1-Print-Hub-macOS-AppleSilicon` / `-Intel`): right-click → **Open**
  the first time to clear Gatekeeper. You may need `chmod +x` it.
- **Linux** (`U1-Print-Hub-Linux-x64`): `chmod +x` then run it.

`config.json` and a `gcode/` folder are created next to the executable on first run.
Use **Settings** in the page to add your printers.

---

## Run from source (developers)

## 1. Install

You need **Node.js 18 or newer** - get the **LTS** build from https://nodejs.org and
run the installer (defaults are fine).

Then:

1. Unzip this folder somewhere permanent, e.g. `C:\u1-print-hub`.
2. Start it:
   - **Windows:** double-click **`start-windows.bat`**
   - **Mac / Linux:** run **`./start-mac-linux.sh`** in a terminal

The first launch installs what it needs (takes a minute) and then opens
**http://localhost:4545** in your browser.

> **Use it from your phone:** find the IP of the computer running the hub and open
> `http://THAT-IP:4545` on your phone - e.g. `http://192.168.1.20:4545`. Keep the hub
> running on a computer that stays on (or set the launcher to run at startup).

---

## 2. First-time setup (all in the browser - no files to edit)

The **Settings** panel opens automatically the first time. Three steps:

1. **Add your printers.** Click **Discover on network** to scan your LAN and list any
   Snapmaker U1s it finds - click **Add** on each. (Or **Add manually** and type an IP.)
2. **Set your G-code folder.** Point it at the folder Snapmaker Orca saves sliced files to.
3. **Save.**

That's it. Reopen Settings anytime with the gear button.

---

## 3. Using it

- **Pick a file** from the left to see the colors it needs.
- **Each machine card** shows its four heads with the colors currently loaded, plus
  status. When a job is selected, you get a per-color **"Send each color from"** picker
  (defaulted to the best match) and **Upload** / **Print** buttons.
- **Press Print** to send to that machine. If you set the color mapping, the file is
  pre-aligned so the machine's confirmation screen comes up correct.

### Keep your printer IPs from changing

Open **Network inventory** at the bottom - it lists every machine's **MAC address**.
In your router, add a **DHCP reservation** binding each MAC to its current IP. After that,
addresses never move and you won't have to touch anything.

---

## Notes

- **Toolhead mapping** is set the same way Snapmaker Orca does it: the hub
  uploads the file, sends the `SET_PRINT_EXTRUDER_MAP` macros for your chosen
  head assignment, then starts the print. The dropdowns pick which physical head
  prints each color.
- **LAN only, no password.** Anyone who can reach the hub can push prints. Keep it on your
  home/shop network - **don't expose it to the internet or forward a port to it.**

---

## Found this useful?

**Buy me a beer** -> https://venmo.com/u/dgambill  (Venmo @dgambill). No pressure, all appreciated.

## License

MIT - see `LICENSE`. Free to use, change, and share.

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
4. Everything lands in `capture-<timestamp>.log`. The upload and any mapping call
   will be in there in plain text.
5. When done, point Orca's host back at the real printer IP.

If the log shows a mapping field or call, that's the lever to replicate. If it
shows only the gcode upload with no mapping, the mapping is decided on the
machine's screen — also useful to know.


---

## For maintainers: building & releasing

Single-file executables are built by `pkg`. To cut a release, tag a version and push:

```
git tag v1.4.0
git push origin v1.4.0
```

The GitHub Actions workflow (`.github/workflows/release.yml`) builds Windows, macOS
(Intel + Apple Silicon), and Linux binaries and attaches them to a new Release.
To build locally instead: `npm install && npm run build` (output in `dist/`).
