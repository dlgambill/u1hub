// Contrast audit for the Hub, measured on the RENDERED page, not on a list of
// tokens. 3MF Explorer audits a hand-listed set of token pairs (its CSS is one
// small stylesheet). The Hub's colors live in index.html, gold.css and every
// module's injected <style>, many hard-coded - a token list would miss most
// of them. So this walks every visible element on every tab and measures what
// the browser actually painted:
//
//   text      - each element with its own visible text: computed color
//               (times inherited opacity) against the background it sits on,
//               found by compositing background-colors up the ancestor chain.
//               Needs 4.5:1, or 3:1 for large text (24px, or 18.66px bold).
//   controls  - inputs, selects, textareas and buttons with a border: the
//               border against the surface around the control. Needs 3:1
//               (WCAG 1.4.11). Disabled controls are exempt, as WCAG says.
//   unstyled  - any button or field still wearing the browser's default
//               light-gray/white background on the dark UI.
//
// Then it repeats the dashboard and Dispatch with every preset type accent,
// because --signal is swapped at runtime and a second printer type must read
// as well as the U1's gold.
//
// Run against a throwaway Hub (never production):
//   node scripts\contrast-audit.js [port]        default 4547; exit 1 on any fail
//   node scripts\contrast-audit.js 4547 --all    also list passing groups
// Needs puppeteer-core in %LOCALAPPDATA%\u1shot-tool (see shoot-docs.js).
"use strict";
const path = require("path");
const puppeteer = require(path.join(process.env.LOCALAPPDATA, "u1shot-tool", "node_modules", "puppeteer-core"));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = /^\d+$/.test(process.argv[2] || "") ? process.argv[2] : "4547";
const BASE = "http://127.0.0.1:" + PORT;
const SHOW_ALL = process.argv.includes("--all");
const PRESETS = ["#5B9BF0", "#46C18C", "#C77DFF", "#FF7A59", "#3EC9C9", "#E0568C", "#A8C64E", "#F0C33C"];

// view: setView() target, entered from the dashboard the way a person does
// (Match and Spools render from the fleet snapshot). ready: a selector that
// proves the view has drawn. Feature-gated views (Match, Spools, Resources)
// only exist when the throwaway's config turns them on - the audit says SKIP
// for any view it could not reach, so a skipped view is visible, not silent.
// "settings" is the Settings sheet over the dashboard, not a view.
const VIEWS = [
  { view: "dash", ready: ".pcard .pill" },
  { view: "dash", ready: ".pcard .pill", then: "document.querySelector('.job') && document.querySelector('.job').click()", label: "dash+jobcard" },
  { view: "match", ready: ".matchcard" },
  { view: "spools", ready: ".spoolrow" },
  { view: "dispatch", ready: ".dsp-grow" },
  { view: "resources", ready: "#modview-resources td" },
  { view: "logbook", ready: ".lgb-row" },
  { view: "models", ready: ".mdl-card" },
  { view: "settings", ready: "#setFeatures [data-feat]", then: "document.getElementById('setup').classList.add('show')" },
];

// Runs inside the page. Returns one record per measured pair.
function measure() {
  // Computed colors arrive as rgb()/rgba(), or color(srgb r g b / a) when the
  // CSS used color-mix(). Both become [r,g,b,a] with r,g,b in 0..255.
  function parse(s) {
    if (!s || s === "transparent") return [0, 0, 0, 0];
    let m = s.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = s.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    return null;
  }
  const over = (top, under) => {           // composite top onto an opaque under
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  };
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = c => "#" + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  // The opaque color behind an element: its own background-color composited
  // over every ancestor's, down to the page. Gradients/images are ignored -
  // the Hub's are faint washes, under 7% accent.
  function bgOf(el, includeSelf) {
    const stack = [];
    for (let n = includeSelf ? el : el.parentElement; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; }
    }
    let out = [255, 255, 255, 1];           // browser canvas default
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out;
  }
  function opacityOf(el) {
    let o = 1;
    for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity);
    return o;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && el.checkVisibility && el.checkVisibility({ opacityProperty: false });
  }
  function sig(el) {
    const parts = [];
    for (let n = el, i = 0; n && n !== document.body && i < 3; n = n.parentElement, i++) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += "#" + n.id;
      else if (n.classList.length) s += "." + [...n.classList].slice(0, 2).join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  }
  // Inactive components are exempt (WCAG 1.4.3 / 1.4.11), and so is the label
  // of a disabled checkbox - it is drawn faded on purpose to say "off".
  const disabled = el => el.closest("[disabled], [aria-disabled=true]") !== null ||
    !!(el.closest("label") && el.closest("label").querySelector("input:disabled"));
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    if (/^(SCRIPT|STYLE|SVG|PATH|OPTION|BR|NOSCRIPT|TEMPLATE)$/i.test(el.tagName)) continue;
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const isField = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|range|color|hidden|file)$/i.test(el.type || "");
    if ((own || (isField && el.value)) && !disabled(el)) {
      const bg = bgOf(el, true);
      const fg0 = parse(cs.color);
      if (fg0) {
        const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacityOf(el)], bg);
        const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = px >= 24 || (bold && px >= 18.66);
        const text = (own ? [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("") : el.value).trim().slice(0, 40);
        out.push({ kind: "text", sig: sig(el), fg: hex(fg), bg: hex(bg), r: ratio(fg, bg), need: large ? 3 : 4.5, text });
      }
    }
    // A control with no background of its own draws the browser's light-gray
    // (button) or white (field) default on the dark Hub - how Cancel and
    // Dispatch's replan buttons looked before v2.41. Always a miss.
    // (Swatches paint their filament color inline - a white roll is white on
    // purpose - so an inline background is never "unstyled".)
    if ((isField || el.tagName === "BUTTON") && !el.style.background && !el.style.backgroundColor &&
        /^rgb\((239, 239, 239|240, 240, 240|255, 255, 255)\)$/.test(cs.backgroundColor))
      out.push({ kind: "unstyled", sig: sig(el), fg: cs.color, bg: cs.backgroundColor, r: 0, need: 1, text: (el.textContent || el.placeholder || el.tagName).trim().slice(0, 40) });
    // List rows that happen to be <button>s (the file list, the queue, the
    // filament library) are rows, not controls: their name identifies them
    // and their edge is a divider, the same call 3MF Explorer makes for its
    // table rows. Their TEXT is still measured above.
    const row = el.matches(".job, .qitem, .fcitem");
    if ((isField || el.tagName === "BUTTON") && !row && !disabled(el)) {
      const bw = parseFloat(cs.borderTopWidth);
      if (bw > 0 && cs.borderTopStyle !== "none") {
        const outer = bgOf(el, false);
        const own = bgOf(el, true);
        const b0 = parse(cs.borderTopColor);
        // A transparent border is a deliberately borderless text button (the
        // label alone identifies it, which WCAG accepts) - nothing to measure.
        if (b0 && b0[3] > 0) {
          const b = over([b0[0], b0[1], b0[2], b0[3] * opacityOf(el)], outer);
          // A control is identifiable if EITHER its border or its own fill
          // stands out from the surface around it (a solid accent button has
          // no need for a contrasting border).
          const rb = ratio(b, outer), rf = ratio(own, outer);
          out.push({ kind: "control", sig: sig(el), fg: hex(b), bg: hex(outer), r: Math.max(rb, rf), need: 3, text: (el.textContent || el.placeholder || el.tagName).trim().slice(0, 40) });
        }
      }
    }
  }
  return out;
}

async function audit(page, v, accent) {
  await page.goto(BASE + "/#dash", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".pcard .pill", { timeout: 45000 });
  if (v.view !== "settings") await page.evaluate(view => setView(view), v.view);
  if (v.then && v.view === "settings") await page.evaluate(v.then);
  // 60s: Match's first render after a Hub start reads the whole library.
  await page.waitForSelector(v.ready, { timeout: 60000 });
  // Through applyAccent(), exactly as switching to a type with this accent does.
  if (accent) await page.evaluate(a => { activeType().accent = a; applyAccent(); }, accent);
  if (v.then && v.view !== "settings") await page.evaluate(v.then);
  await new Promise(r => setTimeout(r, 1500));
  return page.evaluate(measure);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-gpu", "--hide-scrollbars"] });
  const groups = new Map();                 // one line per (where, colors) - not per element
  const runs = [];
  for (const w of [1440, 390]) for (const v of VIEWS) runs.push({ v, w, accent: null });
  for (const a of PRESETS) for (const v of VIEWS.filter(x => x.view === "dash" || x.view === "dispatch")) runs.push({ v, w: 1440, accent: a });
  try {
    for (const run of runs) {
      const page = await browser.newPage();
      const label = (run.v.label || run.v.view) + "@" + run.w + (run.accent ? " " + run.accent : "");
      try {
        await page.setViewport({ width: run.w, height: 1000 });
        const recs = await audit(page, run.v, run.accent);
        for (const r of recs) {
          const k = [r.kind, r.sig, r.fg, r.bg].join("|");
          const g = groups.get(k) || { ...r, n: 0, where: new Set() };
          g.n++; g.where.add(label); g.r = Math.min(g.r, r.r);
          groups.set(k, g);
        }
      } catch (e) { console.log("SKIP " + label + ": " + e.message.split("\n")[0]); }
      await page.close();
    }
  } finally { await browser.close(); }
  const all = [...groups.values()].sort((a, b) => a.r / a.need - b.r / b.need);
  const fails = all.filter(g => g.r < g.need);
  for (const g of SHOW_ALL ? all : fails) {
    const ok = g.r >= g.need ? "PASS" : "FAIL";
    console.log(`${ok} ${g.r.toFixed(2)}:1 (needs ${g.need}) ${g.kind} ${g.fg} on ${g.bg}  ${g.sig}  "${g.text}"  x${g.n} [${[...g.where].slice(0, 3).join(", ")}${g.where.size > 3 ? ", ..." : ""}]`);
  }
  console.log(`\n${all.length - fails.length}/${all.length} distinct pairs pass`);
  process.exit(fails.length ? 1 : 0);
})();
