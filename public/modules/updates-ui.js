// public/modules/updates-ui.js — the "a newer Hub exists" notice (v2.18).
// Injected only when features.updates is on. No tab, no HubModules registration:
// this lives in the topbar next to #vbadge and nowhere else.
//
// Why it always renders something, even with no update available: the version
// chip is the only place the update check can be turned OFF. A control that
// appears only when there is news is a control nobody can find when they want
// to stop the news. So the chip shows the running version at rest, becomes the
// notice when there is one, and opens the same small panel either way.
//
// It is deliberately NOT a modal and never steals focus. This is a dashboard
// people open mid-print to answer a question about a machine; "there is a point
// release available" does not get to be the first thing they deal with.
"use strict";
(function () {
  let DATA = null, CHIP = null, PANEL = null, BUSY = false;

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function jget(p) { try { const r = await fetch(p); return r.ok ? r.json() : null; } catch { return null; } }
  async function jpost(p, b) {
    try {
      const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b || {}) });
      return r.ok ? r.json() : null;
    } catch { return null; }
  }

  const ago = ms => {
    if (!ms) return "never";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return "just now";
    const m = Math.round(s / 60); if (m < 90) return m + " min ago";
    const h = Math.round(m / 60); if (h < 36) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  };

  function style() {
    if (document.getElementById("updcss")) return;
    const s = document.createElement("style");
    s.id = "updcss";
    s.textContent = [
      // At rest the chip is quieter than #vbadge — it is not a warning.
      ".updchip{font-family:var(--mono); font-size:10.5px; letter-spacing:.04em;",
      "  color:var(--ink-faint); background:transparent; border:1px solid transparent;",
      "  border-radius:var(--r-sm,6px); padding:4px 9px; cursor:pointer; line-height:1.4;",
      "  min-height:26px; min-width:26px;",
      "  transition:color var(--dur,.18s) var(--ease,ease), border-color var(--dur,.18s) var(--ease,ease);}",
      ".updchip:hover{color:var(--ink-dim); border-color:var(--line);}",
      // With news it borrows the accent, never --bad. A released update is not
      // an error and must not look like one next to the real version warning.
      ".updchip.news{color:var(--signal); border-color:color-mix(in srgb, var(--signal) 45%, var(--line)); font-weight:700;}",
      ".updpanel{position:absolute; z-index:80; min-width:262px; max-width:330px;",
      "  background:var(--panel,#1D2027); border:1px solid var(--line,#3C4250);",
      "  border-radius:var(--r-lg,12px); box-shadow:var(--elev); padding:13px 14px;",
      "  display:flex; flex-direction:column; gap:9px; font-size:12.5px;}",
      ".updpanel h4{margin:0; font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--signal);}",
      ".updpanel .updrow{display:flex; gap:8px; align-items:baseline; justify-content:space-between;}",
      ".updpanel .updk{color:var(--ink-faint); font-size:11.5px;}",
      ".updpanel .updv{font-family:var(--mono); font-size:11.5px; color:var(--ink);}",
      ".updpanel .updnotes{color:var(--ink-dim); line-height:1.5; font-size:12px;",
      "  border-top:1px solid var(--line-soft); padding-top:8px;}",
      ".updpanel .updacts{display:flex; gap:6px; flex-wrap:wrap; margin-top:2px;}",
      ".updpanel .updbtn{font:inherit; font-size:12px; padding:6px 12px; min-height:34px;",
      "  border:1px solid var(--line); border-radius:var(--r-sm,6px); background:transparent;",
      "  color:var(--ink-dim); cursor:pointer; text-decoration:none; display:inline-flex; align-items:center;}",
      ".updpanel .updbtn:hover{color:var(--ink); border-color:color-mix(in srgb, var(--signal) 45%, var(--line));}",
      ".updpanel .updbtn.pri{color:var(--signal); border-color:color-mix(in srgb, var(--signal) 55%, var(--line));}",
      ".updpanel label.updopt{display:flex; gap:8px; align-items:flex-start; color:var(--ink-dim);",
      "  border-top:1px solid var(--line-soft); padding-top:9px; cursor:pointer; line-height:1.45;}",
      ".updpanel label.updopt input{margin-top:2px; flex:none;}",
      ".updpanel .updfine{color:var(--ink-faint); font-size:11px; line-height:1.5;}",
      ".updpanel .upderr{color:var(--ink-faint); font-size:11px; font-family:var(--mono);}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function closePanel() {
    if (PANEL) { PANEL.remove(); PANEL = null; }
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
  }
  function onKey(e) { if (e.key === "Escape") { closePanel(); CHIP && CHIP.focus(); } }
  function onOutside(e) { if (PANEL && !PANEL.contains(e.target) && e.target !== CHIP) closePanel(); }

  function openPanel() {
    if (PANEL) { closePanel(); return; }
    const d = DATA || {};
    PANEL = document.createElement("div");
    PANEL.className = "updpanel";
    PANEL.setAttribute("role", "dialog");
    PANEL.setAttribute("aria-label", "Hub version");

    const rows = [
      '<h4>Hub version</h4>',
      '<div class="updrow"><span class="updk">Installed</span><span class="updv">v' + esc(d.current) + '</span></div>'
    ];
    if (d.enabled) {
      rows.push('<div class="updrow"><span class="updk">Latest known</span><span class="updv">' +
        (d.latest ? "v" + esc(d.latest) : "—") + '</span></div>');
      rows.push('<div class="updrow"><span class="updk">Checked</span><span class="updv">' + esc(ago(d.last_check)) + '</span></div>');
      // An offline farm is the expected case, so the failure reads as a fact,
      // not a problem to solve.
      if (d.last_error && !d.last_ok)
        rows.push('<div class="upderr">no answer from the manifest (' + esc(d.last_error) + ') — normal on a LAN with no internet</div>');
    }
    if (d.newer && d.notes) rows.push('<div class="updnotes">' + esc(d.notes) + '</div>');

    const acts = [];
    if (d.newer) {
      const href = d.link || "https://github.com/dlgambill/u1hub/releases";
      acts.push('<a class="updbtn pri" href="' + esc(href) + '" target="_blank" rel="noopener">Release notes</a>');
      acts.push('<button class="updbtn" data-act="dismiss">Not now</button>');
    } else if (d.enabled) {
      acts.push('<button class="updbtn" data-act="check">Check now</button>');
    }
    if (acts.length) rows.push('<div class="updacts">' + acts.join("") + '</div>');

    rows.push(
      '<label class="updopt"><input type="checkbox" data-act="toggle"' + (d.enabled ? " checked" : "") + '>' +
      '<span>Check for new versions<br><span class="updfine">A plain request for one small file on GitHub, at most once every ' +
      esc(d.interval_hours || 24) + ' h. It sends no version, no identifier and nothing about this farm. ' +
      'Turn it off and no request is made at all.</span></span></label>');

    PANEL.innerHTML = rows.join("");
    document.body.appendChild(PANEL);

    // Anchor under the chip, then pull back inside the viewport on a phone.
    const r = CHIP.getBoundingClientRect();
    PANEL.style.top = (window.scrollY + r.bottom + 6) + "px";
    const w = PANEL.offsetWidth;
    let left = window.scrollX + r.left;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - w - 10;
    PANEL.style.left = Math.max(window.scrollX + 10, Math.min(left, maxLeft)) + "px";

    PANEL.addEventListener("click", onPanelClick);
    PANEL.addEventListener("change", onPanelClick);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
    const first = PANEL.querySelector("a,button,input");
    if (first) first.focus();
  }

  async function onPanelClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t || BUSY) return;
    const act = t.getAttribute("data-act");
    if (act === "dismiss") {
      BUSY = true;
      const next = await jpost("/api/updates/dismiss", { version: DATA && DATA.latest });
      BUSY = false;
      if (next) DATA = next;
      closePanel(); render();
    } else if (act === "check") {
      BUSY = true; t.textContent = "Checking…";
      const next = await jpost("/api/updates/check", {});
      BUSY = false;
      if (next) DATA = next;
      closePanel(); render();
      if (DATA && !DATA.newer) openPanel();     // show the result, not silence
    } else if (act === "toggle") {
      BUSY = true;
      const next = await jpost("/api/updates/settings", { enabled: !!t.checked });
      BUSY = false;
      if (next) DATA = next;
      closePanel(); render(); openPanel();
    }
  }

  function render() {
    if (!CHIP || !DATA) return;
    const news = !!DATA.notify;
    CHIP.classList.toggle("news", news);
    // At rest this is a glyph, NOT the version number: #vbadge immediately to
    // its left already prints "v2.18.0" when page and server agree, and two
    // identical version strings side by side in the topbar reads as a bug. The
    // refresh glyph carries the one thing vbadge does not — that this is the
    // control for checking. The accessible name does the explaining.
    CHIP.textContent = news ? ("update: v" + DATA.latest) : "↻";
    CHIP.title = news
      ? ("v" + DATA.latest + " is available — you are on v" + DATA.current)
      : "Hub version and update settings";
    CHIP.setAttribute("aria-label", CHIP.title);
  }

  async function boot() {
    const bar = document.querySelector(".topbar");
    if (!bar) return;
    style();
    CHIP = document.createElement("button");
    CHIP.className = "updchip";
    CHIP.id = "updchip";
    CHIP.type = "button";
    CHIP.textContent = "…";
    CHIP.addEventListener("click", openPanel);
    // Immediately after #vbadge when it exists, so the two version statements
    // sit together instead of at opposite ends of the bar.
    const badge = bar.querySelector("#vbadge");
    if (badge && badge.nextSibling) bar.insertBefore(CHIP, badge.nextSibling);
    else bar.appendChild(CHIP);

    DATA = await jget("/api/updates");
    if (!DATA) { CHIP.remove(); CHIP = null; return; }   // module off or erroring: show nothing
    render();
    // Re-read hourly. The server decides when to actually go out to the network;
    // this only picks up a result that arrived after page load.
    setInterval(async () => {
      const next = await jget("/api/updates");
      if (next) { DATA = next; render(); }
    }, 3600e3);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
