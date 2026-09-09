// Reshoots the README screenshots against the throwaway Hub on 4546 (boot it
// with scripts\boot-4546.cmd first, stop it after). Because 4546 is seeded
// from production state, the pictures show the real farm without a single
// click landing on the real install.
//
// Uses puppeteer-core driving the locally installed Chrome. Plain headless
// --screenshot flags were tried first and could not photograph Fluidd: they
// shoot on a timer, Fluidd needs its WebSocket up before there is anything to
// see, and there is no flag for "wait until the page says it is ready".
// Puppeteer waits on real conditions instead of guesses.
//
// One-time setup (kept OUTSIDE the repo, in %LOCALAPPDATA%\u1shot-tool):
//   mkdir %LOCALAPPDATA%\u1shot-tool && cd /d %LOCALAPPDATA%\u1shot-tool
//   npm init -y && npm install puppeteer-core@23
//
//   node scripts\shoot-docs.js            all shots
//   node scripts\shoot-docs.js dispatch   just one
"use strict";
const path = require("path");
const fs = require("fs");

const TOOL = path.join(process.env.LOCALAPPDATA, "u1shot-tool", "node_modules", "puppeteer-core");
let puppeteer;
try { puppeteer = require(TOOL); }
catch (e) {
  console.error("puppeteer-core not found — run the one-time setup in this file's header.");
  process.exit(1);
}

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:4546";
const OUT = path.join(__dirname, "..", "docs");

// ready: a condition the page itself proves, so the shot is of a FINISHED
// page, never a lucky timer. Text conditions are checked against innerText.
const SHOTS = [
  { name: "dash",      file: "dashboard.png",        w: 1440, h: 1000, url: "/#dash",      ready: ".pcard .pill" },
  // Dispatch needs the fleet AND a rendered plan; land on the dashboard so the
  // fleet is up, switch, then wait for actual plan rows (.dsp-grow), not just
  // the empty form.
  // v2.23: the JOBS drawer opens by default in a fresh profile and, on a
  // 35-job farm, fills the whole frame - collapse it so the timeline, which is
  // what the README caption promises, is the picture.
  { name: "dispatch",  file: "dispatch.png",         w: 1440, h: 1300, url: "/#dash", ready: ".pcard .pill", thenView: "dispatch", thenReady: ".dsp-grow", thenClick: "#dsp-jobs-toggle", extraMs: 2500 },
  { name: "resources", file: "resources.png",        w: 1440, h: 1300, url: "/#resources", ready: "#modview-resources .rtab td" },
  { name: "spools",    file: "spools-inventory.png", w: 1440, h: 1300, url: "/#spools",    ready: ".spoolrow" },
  // Match renders from the fleet snapshot, and the deep link lands before the
  // fleet has answered — so this one enters through the dashboard, waits for
  // the cards, and then switches tabs the way a person does.
  { name: "match",     file: "spool-match.png",      w: 1440, h: 1000, url: "/#dash",      ready: ".pcard .pill", thenView: "match", thenReady: ".matchcard" },
  { name: "settings",  file: "features-panel.png",   w: 1440, h: 1300, url: "/#settings",  ready: "#setFeatures [data-feat]" },
  { name: "klipper",   file: "klipper-proxy.png",    w: 1440, h: 1000, url: "/p/0/",       readyText: /Home|Console|Extruder/i, extraMs: 3000 },
  { name: "phone",     file: "remote-phone.png",     w: 390,  h: 844,  url: "/#dash",      ready: ".pcard .pill" }
];

(async () => {
  const only = process.argv[2];
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-gpu", "--hide-scrollbars"] });
  let bad = 0;
  try {
    for (const s of SHOTS) {
      if (only && s.name !== only) continue;
      const dest = OUT + "\\" + s.file;
      try { fs.unlinkSync(dest); } catch {}
      const page = await browser.newPage();
      try {
        await page.setViewport({ width: s.w, height: s.h });
        await page.goto(BASE + s.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (s.ready)
          await page.waitForSelector(s.ready, { timeout: 30000 });
        else if (s.readyText)
          // The pattern crosses into the page as a STRING — a RegExp does not
          // survive puppeteer's argument serialization (it arrives as {}).
          await page.waitForFunction(src => new RegExp(src, "i").test(document.body.innerText),
            { timeout: 45000 }, s.readyText.source);
        if (s.thenView) {
          await page.evaluate(v => setView(v), s.thenView);
          await page.waitForSelector(s.thenReady, { timeout: 30000 });
        }
        if (s.thenClick) { await page.click(s.thenClick); await new Promise(r => setTimeout(r, 600)); }
        // Let live tiles (progress bars, sparklines, thumbnails) finish a tick.
        await new Promise(r => setTimeout(r, s.extraMs || 1500));
        await page.screenshot({ path: dest });
        console.log("  ok   " + s.name.padEnd(10) + s.file + "  " + fs.statSync(dest).size + " bytes");
      } catch (e) {
        bad++;
        console.log("  FAIL " + s.name.padEnd(10) + s.file + "  " + e.message.split("\n")[0]);
        try { await page.screenshot({ path: dest.replace(/\.png$/, ".FAILED.png") }); } catch {}
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(bad ? "\n" + bad + " shot(s) FAILED" : "\nall shots landed — review them before committing");
  process.exit(bad ? 1 : 0);
})();
