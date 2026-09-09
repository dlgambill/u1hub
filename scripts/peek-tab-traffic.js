// Read-only: what does the page actually REQUEST when it loads and when you
// switch tabs? Drives the throwaway Hub on 4546 with the same puppeteer-core
// shoot-docs.js uses, and prints every request per phase with its duration,
// so "it takes several seconds" can be attributed to real calls.
"use strict";
const path = require("path");
const puppeteer = require(path.join(process.env.LOCALAPPDATA, "u1shot-tool", "node_modules", "puppeteer-core"));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:4546";

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-gpu"] });
  const page = await browser.newPage();
  // `phone` = a phone on the tunnel: small viewport, 4x slower CPU, 120 ms RTT
  // on every request, LTE-ish bandwidth. `latency` = only the RTT (desktop CPU),
  // `cpu` = only the slow CPU (LAN network) — to tell which one dominates.
  const mode = process.argv[2] || "lan";
  if (mode === "phone" || mode === "cpu") { await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 3 }); await page.emulateCPUThrottling(4); }
  else await page.setViewport({ width: 1440, height: 1000 });
  if (mode === "phone" || mode === "latency") {
    const cdp = await page.createCDPSession();
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 120, downloadThroughput: 4e6 / 8, uploadThroughput: 1e6 / 8 });
  }
  console.log("mode: " + mode);
  let phase = "load", log = [];
  const started = new Map();
  page.on("request", r => started.set(r, { t: Date.now(), url: r.url(), phase }));
  const done = r => { const s = started.get(r); if (!s) return; s.ms = Date.now() - s.t; const rp = r.response(); s.status = rp ? rp.status() : "-"; s.cached = !!(rp && rp.fromCache()); log.push(s); };
  page.on("requestfinished", done); page.on("requestfailed", done);
  const settle = async ms => { let last = log.length; for (;;) { await new Promise(r => setTimeout(r, ms)); if (log.length === last) break; last = log.length; } };

  const t0 = Date.now();
  await page.goto(BASE + "/#dash", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".pcard .pill", { timeout: 60000 });
  const tCards = Date.now() - t0;
  await settle(800);
  const tLoad = Date.now() - t0;

  phase = "dispatch"; const t1 = Date.now();
  await page.evaluate(() => setView("dispatch"));
  await page.waitForSelector(".dsp-grow", { timeout: 60000 });
  const tPlan = Date.now() - t1;
  await settle(800);
  const tDispatch = Date.now() - t1;

  phase = "dash-again"; const t2 = Date.now();
  await page.evaluate(() => setView("dash"));
  await settle(800);
  const tDash2 = Date.now() - t2;

  // The repeat visit is what a person sees every day: same browser, caches
  // warm. Count what still crosses the wire and how long until the cards.
  phase = "revisit"; const t3 = Date.now();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });   // a real reload, not a hash hop
  await page.waitForSelector(".pcard .pill", { timeout: 60000 });
  const tCards2 = Date.now() - t3;
  await settle(800);
  const tRevisit = Date.now() - t3;
  const fromCache = log.filter(x => x.phase === "revisit" && x.cached).length;
  // Third load: Chrome writes its compiled-code cache for an external script on
  // the second load and only USES it from the third, so this is the steady state.
  phase = "revisit2"; const t4 = Date.now();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".pcard .pill", { timeout: 60000 });
  const tCards3 = Date.now() - t4;
  console.log("\nTHIRD LOAD: page->cards " + tCards3 + " ms");

  await browser.close();
  const rel = u => u.replace(BASE, "");
  console.log("\nREVISIT: page->cards " + tCards2 + " ms, settled " + tRevisit + " ms, " + log.filter(x => x.phase === "revisit").length + " requests (" + fromCache + " served from cache)");
  for (const ph of ["load", "dispatch", "dash-again", "revisit"]) {
    const rows = log.filter(x => x.phase === ph).sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((n, x) => n + x.ms, 0);
    console.log("\n== " + ph + ": " + rows.length + " requests, " + total + " ms summed");
    for (const x of rows.slice(0, 25)) console.log(String(x.ms).padStart(6) + " ms  " + String(x.status).padEnd(4) + rel(x.url).slice(0, 100));
    if (rows.length > 25) console.log("   ... " + (rows.length - 25) + " more");
  }
  console.log("\nWALL: page->cards " + tCards + " ms, page settled " + tLoad + " ms | dispatch->plan rows " + tPlan + " ms, settled " + tDispatch + " ms | back to dash settled " + tDash2 + " ms");
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
