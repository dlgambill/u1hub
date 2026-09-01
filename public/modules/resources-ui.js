// public/modules/resources-ui.js — Resources tab (v2.16). Injected only when
// features.resources is on; mounted through HubModules like dispatch-ui.js.
//
// One job: show what the scheduled queue needs, what is on the shelf, and what
// to buy. Everything numeric comes from /api/resources — this file lays it out
// and never does filament maths of its own, so the badge, the table and the
// totals can never disagree.
//
// Two honesty rules the layout has to carry, not just the server:
//   * a spool with no remaining_g shows "not set", never 0. An invented shortfall
//     is worse than a blank.
//   * a spool with no cost_per_roll shows its rolls but no money, and is left out
//     of the header total with a note saying how many rows were excluded.
"use strict";
(function () {
  let DATA = null, EL = null, SPOOLS = [], BUSY = false;
  let RANGE = "all";        // all | 7 | 14 | 30
  let DEADLINE_ONLY = false;
  try {
    const r = localStorage.getItem("u1.resRange"); if (r) RANGE = r;
    DEADLINE_ONLY = localStorage.getItem("u1.resDeadlineOnly") === "1";
  } catch {}

  const $$ = s => EL.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const g = v => v == null ? "—" : (v >= 1000 ? (v / 1000).toFixed(2) + " kg" : Math.round(v) + " g");
  const money = v => v == null ? "—" : "$" + v.toFixed(2);

  async function jget(p) { const r = await fetch(p); return r.ok ? r.json() : null; }
  async function jpost(p, b) {
    const r = await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b || {}) });
    return r.ok ? r.json() : null;
  }

  // Swatch. Gradient/multi spools carry several hexes; show them as hard
  // segments so a rainbow silk never reads as a flat colour it isn't.
  function swatch(hexes, size) {
    const s = size || 22;
    const hx = (hexes || []).filter(Boolean);
    if (!hx.length) return `<i class="rsw" style="width:${s}px;height:${s}px;background:
      repeating-linear-gradient(45deg,#333 0 4px,#222 4px 8px)"></i>`;
    if (hx.length === 1)
      return `<i class="rsw" style="width:${s}px;height:${s}px;background:${esc(hx[0])}"></i>`;
    const step = 100 / hx.length;
    const stops = hx.map((h, i) => `${esc(h)} ${i * step}% ${(i + 1) * step}%`).join(",");
    return `<i class="rsw" style="width:${s}px;height:${s}px;background:linear-gradient(135deg,${stops})"></i>`;
  }

  const CSS = `
  #modview-resources .rhead{display:flex;flex-wrap:wrap;gap:14px;align-items:center;
    justify-content:space-between;margin:4px 0 14px}
  #modview-resources .rstats{display:flex;flex-wrap:wrap;gap:20px;align-items:baseline}
  #modview-resources .rstat b{font-size:26px;font-weight:800;letter-spacing:-.01em}
  #modview-resources .rstat span{display:block;font-size:10px;letter-spacing:.16em;
    text-transform:uppercase;color:var(--ink-faint);margin-top:2px}
  #modview-resources .rstat.money b{color:var(--signal)}
  #modview-resources .rstat.short b{color:var(--bad)}
  #modview-resources .rctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  #modview-resources .rseg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  #modview-resources .rseg button{background:transparent;border:0;color:var(--ink-faint);
    padding:6px 11px;font:inherit;font-size:12px;cursor:pointer}
  #modview-resources .rseg button.on{background:color-mix(in srgb,var(--signal) 22%,transparent);color:var(--ink)}
  #modview-resources .rchk{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--ink-faint)}
  #modview-resources .rwarn{border:1px solid color-mix(in srgb,var(--bad) 40%,var(--line));
    background:color-mix(in srgb,var(--bad) 10%,transparent);border-radius:10px;
    padding:10px 13px;margin-bottom:12px;font-size:13px}
  #modview-resources .rwarn b{color:var(--bad)}
  #modview-resources .rnote{font-size:12px;color:var(--ink-faint);margin:10px 2px 0}
  /* v2.21: the affiliate disclosure lives at the bottom and dresses like the
     footnote it is, not like a warning. */
  #modview-resources .rdisc{margin-top:14px}
  #modview-resources .rdisc .rdisctxt{font-size:11.5px;color:var(--ink-faint);line-height:1.5}
`;

  const CSS2 = `
  #modview-resources table.rtab{width:100%;border-collapse:collapse;font-size:13px}
  #modview-resources .rtab th{text-align:left;font-size:10px;letter-spacing:.14em;
    text-transform:uppercase;color:var(--ink-faint);font-weight:600;
    padding:0 10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
  #modview-resources .rtab th.num,#modview-resources .rtab td.num{text-align:right}
  #modview-resources .rtab td{padding:9px 10px;border-bottom:1px solid
    color-mix(in srgb,var(--line) 55%,transparent);vertical-align:middle}
  #modview-resources .rtab tr.short td{background:color-mix(in srgb,var(--bad) 9%,transparent)}
  #modview-resources .rtab tr.short td:first-child{box-shadow:inset 3px 0 0 var(--bad)}
  #modview-resources .rtab tr.unknown td:first-child{box-shadow:inset 3px 0 0 var(--ink-faint)}
  #modview-resources .rsw{display:inline-block;border-radius:5px;border:1px solid rgba(255,255,255,.16);
    vertical-align:middle;flex:0 0 auto}
  #modview-resources .rcol{display:flex;align-items:center;gap:9px}
  #modview-resources .rhex{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;
    color:var(--ink-faint)}
  #modview-resources .rspool{font-size:12px;color:var(--ink-faint);margin-top:1px}
  #modview-resources .rtag{display:inline-block;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;
    padding:2px 6px;border-radius:5px;border:1px solid var(--line);color:var(--ink-faint);margin-left:6px}
  #modview-resources .rtag.rev{border-color:color-mix(in srgb,var(--busy) 55%,var(--line));color:var(--busy)}
  #modview-resources .rtag.una{border-color:color-mix(in srgb,var(--bad) 45%,var(--line));color:var(--bad)}
  #modview-resources .rtag.orph{border-color:color-mix(in srgb,var(--busy) 60%,var(--line));color:var(--busy);
    background:color-mix(in srgb,var(--busy) 12%,transparent)}
  #modview-resources .rtag.map{border-color:color-mix(in srgb,var(--ok) 45%,var(--line));color:var(--ok)}
  #modview-resources .redit{background:transparent;border:1px dashed var(--line);border-radius:6px;
    color:var(--ink);padding:3px 7px;font:inherit;font-size:12.5px;cursor:text;min-width:62px;text-align:right}
  #modview-resources .redit.unset{color:var(--ink-faint);font-style:italic}
  #modview-resources .redit.editing{border-style:solid;cursor:text}
  #modview-resources .redit:hover{color:var(--ink);
    border-color:color-mix(in srgb,var(--signal) 45%,var(--line))}
  /* v2.20: .rbuy is an <a> now (see the render comment). It has to keep looking
     and sizing exactly like the button it replaced, so: inline-flex to centre
     the label the way a button did, and text-decoration:none to lose the
     underline an anchor brings with it. font:inherit matters — an anchor does
     not inherit the button font stack for free. */
  #modview-resources .rbuy{display:inline-flex;align-items:center;justify-content:center;
    font:inherit;text-decoration:none;
    padding:4px 10px;font-size:11.5px;border-radius:7px;border:1px solid var(--line);
    background:transparent;color:var(--ink);cursor:pointer;white-space:nowrap}
  #modview-resources a.rbuy:hover{border-color:color-mix(in srgb,var(--signal) 45%,var(--line));color:var(--ink)}
  #modview-resources .rbuy.go{border-color:color-mix(in srgb,var(--signal) 50%,var(--line));color:var(--signal)}
  #modview-resources .rbuy:disabled{opacity:.35;cursor:default}
  #modview-resources select.rmap{background:var(--chassis);color:var(--ink);border:1px solid var(--line);
    border-radius:6px;padding:3px 6px;font:inherit;font-size:11.5px;max-width:190px}
  /* Wide content scrolls INSIDE its own box. Never let the table push the
     document sideways — and never reach for html/body overflow to stop it:
     that broke the Cloudflare tunnel on 2026-08-30 (MISTAKES.md). The fix
     belongs on the element that is too wide, which is this table. */
  #modview-resources .rscroll{overflow-x:auto;-webkit-overflow-scrolling:touch}

  /* ---- Phone layout ------------------------------------------------------
     Below 700px an 8-column table is unreadable at any zoom, and Danny checks
     this from his phone while away from the shop — that is the primary use,
     not a fallback. Each row becomes a card: colour identity on top, then the
     numbers as labelled pairs. th labels come through data-label so there is
     one source of truth for the column names. */
  @media (max-width:700px){
    #modview-resources .rtab thead{position:absolute;left:-9999px}
    #modview-resources .rtab,#modview-resources .rtab tbody,
    #modview-resources .rtab tr,#modview-resources .rtab td{display:block;width:100%}
    #modview-resources .rtab tr{border:1px solid var(--line);border-radius:11px;
      padding:11px 12px;margin-bottom:10px;background:color-mix(in srgb,#fff 2%,transparent)}
    #modview-resources .rtab tr.short{border-color:color-mix(in srgb,var(--bad) 55%,var(--line))}
    #modview-resources .rtab td{border:0;padding:0}
    #modview-resources .rtab tr.short td:first-child,
    #modview-resources .rtab tr.unknown td:first-child{box-shadow:none}
    /* material rides along with the colour cell instead of owning a line */
    #modview-resources .rtab td.c-material{position:absolute;left:-9999px}
    #modview-resources .rtab td.c-colour{margin-bottom:9px}
    #modview-resources .rtab td.c-colour .rspool{margin-top:5px}
    #modview-resources .rtab td.c-colour select.rmap{max-width:100%;width:100%;padding:7px}
    /* numbers: two per row, label above value */
    #modview-resources .rtab td.num{display:inline-block;width:50%;text-align:left;
      padding:5px 0;vertical-align:top}
    #modview-resources .rtab td.num::before{content:attr(data-label);display:block;
      font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-faint);
      margin-bottom:2px}
    /* Editable cells need a thumb-sized target, not a 12px chip. */
    #modview-resources .rtab td.num .redit{padding:7px 10px;font-size:13px;min-width:88px;
      text-align:left;width:auto}
    #modview-resources .rtab td.hide{display:block;margin-top:9px}
    #modview-resources .rtab td.hide .rbuy{width:100%;padding:9px}
    #modview-resources .rstat b{font-size:21px}
    #modview-resources .rstats{gap:14px 16px;min-width:0}
    #modview-resources .rstat span{font-size:9px;letter-spacing:.12em}
    #modview-resources .rhead{gap:10px}
    #modview-resources .rctl{width:100%}
    #modview-resources .rseg{flex:1 1 auto}
    #modview-resources .rseg button{flex:1 1 auto;padding:7px 8px}
    /* the warning's action button was being pushed off-screen by the prose */
    #modview-resources .rwarn button{display:block;width:100%;margin:9px 0 0 !important}
    #modview-resources .rnote{font-size:11.5px;line-height:1.5}
  }
  /* material chip only exists on the phone layout, where the column is hidden */
  #modview-resources .rtag.rmat{display:none}
  @media (max-width:700px){ #modview-resources .rtag.rmat{display:inline-block} }
`;

  function mount(el) {
    EL = el;
    const st = document.createElement("style");
    st.textContent = CSS + CSS2;
    document.head.appendChild(st);
    el.innerHTML = `
      <div class="sechead"><h2>RESOURCES</h2></div>
      <div class="rhead">
        <div class="rstats" id="res-stats"></div>
        <div class="rctl">
          <div class="rseg" id="res-range">
            <button data-r="all">All scheduled</button>
            <button data-r="7">7 days</button>
            <button data-r="14">14 days</button>
            <button data-r="30">30 days</button>
          </div>
          <label class="rchk"><input type="checkbox" id="res-dl"> deadline only</label>
          <button class="btn" id="res-refresh">Refresh</button>
        </div>
      </div>
      <div id="res-warn"></div>
      <div id="res-body"><p class="subnote">Loading…</p></div>
      <p class="rnote" id="res-foot"></p>
      <div id="res-disc"></div>`;

    $$("#res-range").addEventListener("click", e => {
      const b = e.target.closest("button[data-r]"); if (!b) return;
      RANGE = b.dataset.r;
      try { localStorage.setItem("u1.resRange", RANGE); } catch {}
      load();
    });
    $$("#res-dl").addEventListener("change", e => {
      DEADLINE_ONLY = e.target.checked;
      try { localStorage.setItem("u1.resDeadlineOnly", DEADLINE_ONLY ? "1" : "0"); } catch {}
      load();
    });
    $$("#res-refresh").addEventListener("click", load);
  }

  // The date range bounds `deadline`, which is the only date a job actually
  // carries. Danny's call: show everything scheduled by default whether or not
  // it makes a deadline, and let "deadline only" narrow it deliberately —
  // otherwise 38 of 41 jobs (the ones with deadline 0) would vanish from a view
  // whose whole point is "what do I need to buy".
  function query() {
    const q = [];
    if (DEADLINE_ONLY) q.push("deadline_only=1");
    if (RANGE !== "all") {
      q.push("from=" + Date.now());
      q.push("to=" + (Date.now() + (+RANGE) * 86400000));
    }
    return q.length ? "?" + q.join("&") : "";
  }

  async function load() {
    if (BUSY) return;
    BUSY = true;
    try {
      const [d, s] = await Promise.all([jget("/api/resources" + query()), jget("/api/resources/spools")]);
      DATA = d; SPOOLS = (s && s.spools) || [];
      render();
    } catch (e) {
      $$("#res-body").innerHTML = `<p class="subnote">Could not load resources: ${esc(e.message)}</p>`;
    } finally { BUSY = false; }
  }

  function render() {
    document.querySelectorAll("#res-range button").forEach(b =>
      b.classList.toggle("on", b.dataset.r === RANGE));
    $$("#res-dl").checked = DEADLINE_ONLY;

    if (!DATA) { $$("#res-body").innerHTML = `<p class="subnote">Dispatch is off — nothing is scheduled.</p>`; return; }
    const T = DATA.totals;

    $$("#res-stats").innerHTML = [
      `<div class="rstat money"><b>${money(T.est_cost)}</b><span>to buy</span></div>`,
      `<div class="rstat"><b>${g(T.needed_g)}</b><span>needed</span></div>`,
      `<div class="rstat short"><b>${T.short_colors}</b><span>colours short</span></div>`,
      `<div class="rstat"><b>${T.rolls_to_buy}</b><span>rolls</span></div>`,
      `<div class="rstat"><b>${DATA.counted_units}</b><span>units queued</span></div>`
    ].join("");
    renderWarnings();
    renderTable();
    renderFoot();
  }

  // Unresolved jobs are shown, loudly, and never dropped from the count. A
  // silently shorter list is the one failure mode that makes this whole tab
  // untrustworthy: you cannot tell "nothing needed" from "couldn't read it".
  function renderWarnings() {
    const w = [];
    const U = DATA.unresolved || [];
    if (U.length) {
      const items = U.slice(0, 6).map(u =>
        `<li>${esc(u.file)} &times;${u.units} — ${esc(u.reason)}</li>`).join("");
      w.push(`<div class="rwarn"><b>${U.length} job${U.length > 1 ? "s" : ""} could not be read</b>
        — their filament is NOT counted below.
        <ul style="margin:6px 0 0 18px;padding:0">${items}</ul>
        ${U.length > 6 ? `<div style="margin-top:4px">…and ${U.length - 6} more</div>` : ""}</div>`);
    }
    const T = DATA.totals;
    // Orphans get their own warning rather than a quiet tag, because the row
    // that caused this bug looked exactly like a colour you had simply never
    // got around to mapping.
    const OI = DATA.orphaned_inv || [];
    if (T.orphaned || OI.length) {
      const bits = [];
      if (T.orphaned) bits.push(`<b>${T.orphaned} colour${T.orphaned > 1 ? "s were" : " was"}
        mapped to a spool that is no longer on the shelf.</b> The mapping is kept, not
        guessed at — pick the replacement from the dropdown on those rows.`);
      // v2.20: an entry nothing refers to is deleted server-side the moment the
      // spool goes, so this can only be an entry a colour above still points at
      // — i.e. numbers being HELD for a mapping, not litter. Say that, and keep
      // the manual escape hatch for someone who wants them gone now.
      if (OI.length) bits.push(`${OI.length === 1 ? "A roll" : OI.length + " rolls"} above
        ${OI.length === 1 ? "is" : "are"} mapped to filament that has left the shelf, so
        ${OI.length === 1 ? "its" : "their"} numbers (${OI.map(o =>
          (o.remaining_g == null ? "?" : Math.round(o.remaining_g) + " g")
          + (o.cost_per_roll == null ? "" : " @ $" + o.cost_per_roll)).join(", ")})
        ${OI.length === 1 ? "is" : "are"} being kept for the replacement.
        <span class="rforget">${OI.map(o => `<button class="invf" data-forget="${esc(o.spool_id)}"
          title="Delete the inventory recorded against spool ${esc(o.spool_id)}. Its numbers are shown above; this cannot be undone.">
          forget ${esc(o.spool_id)}</button>`).join(" ")}</span>`);
      w.push(`<div class="rwarn" style="border-color:color-mix(in srgb,var(--busy) 45%,var(--line));
        background:color-mix(in srgb,var(--busy) 8%,transparent)">${bits.join("<br>")}</div>`);
    }
    if (T.unknown_on_hand) {
      w.push(`<div class="rwarn" style="border-color:var(--line);background:transparent">
        <b style="color:var(--ink)">${T.unknown_on_hand} colour${T.unknown_on_hand > 1 ? "s have" : " has"}
        no on-hand amount set.</b> Shortfall and cost stay blank for those rows rather than
        assuming the shelf is empty — click a dash in the ON HAND column to set one.
        <button class="btn" id="res-assume" style="margin-left:10px;padding:3px 9px;font-size:11.5px">
        ${DATA.settings.assume_empty_when_unset ? "Stop assuming empty" : "Assume empty (worst case)"}</button>
      </div>`);
    }
    // v2.19 affiliate disclosure, v2.21 at the BOTTOM of the page (#res-disc,
    // after the table and the footnote). Danny's call: at the top it was the
    // first thing on every visit — a warning-shaped box for something that is
    // not a warning — and the switch now lives in Settings besides. It stays on
    // the page (the honest place for a disclosure is near the links it covers,
    // and removing it entirely was the other option offered) but it reads as a
    // footnote now, which is what it is. Still shown only when a tag is
    // actually riding on rendered links; the off-notice still appears whenever
    // the switch is off, so the way back on is visible where the way off was.
    const A = DATA.affiliate || {};
    const disc = [];
    if (A.active && A.tagged_rows > 0) {
      disc.push(`<div class="rwarn rdisc" style="border-color:var(--line);background:transparent">
        <span class="rdisctxt">The "Replenish on Amazon" links on this page are Amazon affiliate links —
        if you buy through one, this project earns a small commission at no extra cost to you.
        Prices and availability are Amazon's; the Hub does not check them.</span>
        <button class="btn" id="res-aff" style="margin-left:10px;padding:3px 9px;font-size:11.5px">Turn off</button>
      </div>`);
    } else if (A.enabled === false) {
      disc.push(`<div class="rwarn rdisc" style="border-color:var(--line);background:transparent">
        <span class="rdisctxt">Affiliate links are off — the "Replenish on Amazon" links go out untagged.${
          A.tag_set ? "" : " No associate tag is stored, so turning this on will do nothing until one is set."}</span>
        <button class="btn" id="res-aff" style="margin-left:10px;padding:3px 9px;font-size:11.5px">Turn on</button>
      </div>`);
    }
    $$("#res-warn").innerHTML = w.join("");
    $$("#res-disc").innerHTML = disc.join("");
    const affb = $$("#res-aff");
    if (affb) affb.addEventListener("click", async () => {
      affb.disabled = true;
      await jpost("/api/resources/affiliate", { enabled: !(DATA.affiliate || {}).enabled });
      load();
    });
    const ab = $$("#res-assume");
    if (ab) ab.addEventListener("click", async () => {
      await jpost("/api/resources/settings",
        { assume_empty_when_unset: !DATA.settings.assume_empty_when_unset });
      load();
    });
    // v2.19: act on the orphan warning instead of only reading it. The grams
    // and price are printed immediately to the left of the button, so the
    // "are you sure" is the sentence itself rather than a modal — and the
    // server refuses to forget anything still on the shelf, so the worst a
    // mis-click can lose is a number for a roll that no longer exists.
    EL.querySelectorAll("[data-forget]").forEach(b => b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = "forgetting…";
      const r = await jpost("/api/resources/inventory/forget", { spool_id: b.dataset.forget });
      if (!r) { b.disabled = false; b.textContent = "couldn't — try again"; return; }
      load();
    }));
  }

  function matchTag(r) {
    // Orphan is checked before unassigned because an orphaned row IS unassigned
    // — but "you mapped this and the spool is gone" and "this was never mapped"
    // are different problems with different fixes, and collapsing them is what
    // made the original failure invisible.
    if (r.match === "orphan")
      return `<span class="rtag orph" title="Mapped to spool ${esc(r.orphan_of || "")}, which is no longer on the shelf — pick its replacement">orphaned</span>`;
    if (r.unassigned) return `<span class="rtag una">unassigned</span>`;
    if (r.match === "mapped") return `<span class="rtag map">mapped</span>`;
    if (r.match === "exact") return "";
    return `<span class="rtag${r.needs_review ? " rev" : ""}">&Delta;E ${r.match_de}</span>`;
  }

  function spoolOptions(sel) {
    const opts = SPOOLS.map(s => {
      const label = [s.brand, s.material_variant || s.material, s.color_name].filter(Boolean).join(" ");
      return `<option value="${esc(s.id)}"${s.id === sel ? " selected" : ""}>${esc(label)}</option>`;
    }).join("");
    return `<option value="">— map to spool —</option>` + opts;
  }

  function renderTable() {
    const rows = DATA.rows || [];
    if (!rows.length) {
      $$("#res-body").innerHTML = `<p class="subnote">Nothing scheduled in this range.</p>`;
      return;
    }
    const body = rows.map(r => {
      const cls = r.shortfall_g > 0 ? "short" : (r.on_hand_g == null ? "unknown" : "");
      // Both editable cells go through the same data-inv/data-k pair, so the
      // wiring below is one handler rather than one per field.
      const inv = (id, k, shown, unset) => id
        ? `<button class="redit${shown==null?" unset":""}" data-inv="${esc(id)}" data-k="${k}">${shown==null?unset:shown}</button>`
        : `<span class="rhex">—</span>`;
      const onHand = inv(r.spool_id, "remaining_g", r.on_hand_known ? g(r.on_hand_g) : null, "not set");
      // Price is editable HERE, not only on the Spools tab. This is where you
      // are standing when you find out a row has no price — sending you to
      // another tab to fix it (and, on a phone, to hunt for the same spool in a
      // second list) is the whole reason it never got filled in.
      const price = inv(r.spool_id, "cost_per_roll",
        r.cost_per_roll == null ? null : "$" + r.cost_per_roll.toFixed(2), "set price");
      // v2.19: a row with no purchase link falls back to an Amazon SEARCH. The
      // Hub has not checked that the filament exists there — it cannot, without
      // the Product Advertising API — so the label must not promise a specific
      // product. "Replenish on Amazon" is honest about both cases: it says
      // where you land, not what is waiting there.
      // v2.20: a real anchor, not a button driven by window.open(). A popup
      // blocker eats window.open silently — no error, no tab, nothing to
      // diagnose — and "the buy links aren't live" is exactly what that looks
      // like from the outside. An <a target="_blank"> is a plain navigation and
      // is never blocked. It is also middle-clickable and copyable, which a
      // button never was.
      // v2.21: one label, "Replenish on Amazon", whether the click lands on a
      // saved product link or a search. "Buy" vs "Search" made the user read
      // the button to work out which kind of link they had — a distinction that
      // matters to the code and not at all to the person restocking a colour.
      // The destination still differs and the title still says which.
      const b = r.buy;
      const buy = !b
        ? `<button class="rbuy" disabled title="Not enough detail on this spool to search Amazon for it">Replenish on Amazon</button>`
        : b.kind === "search"
          ? `<a class="rbuy" href="${esc(b.url)}" target="_blank" rel="noopener"
               title="Searches Amazon for ${esc(r.material)} ${esc(r.spool_name || r.color_hex)}${b.tagged ? " (affiliate link)" : ""}">Replenish on Amazon</a>`
          : `<a class="rbuy go" href="${esc(b.url)}" target="_blank" rel="noopener"
               title="${esc(b.url)}${b.tagged ? " (affiliate link)" : ""}">Replenish on Amazon</a>`;
      // On a phone the material cell is hidden and its value rides in the
      // colour cell instead — one line per row of chrome saved, and material
      // only ever matters next to the colour anyway.
      return `<tr class="${cls}">
        <td class="c-material">${esc(r.material)}</td>
        <td class="c-colour"><div class="rcol">${swatch(r.unassigned ? [r.color_hex] : (r.spool_hexes.length ? r.spool_hexes : [r.color_hex]))}
          <div style="min-width:0"><span class="rhex">${esc(r.color_hex)}</span>
          <span class="rtag rmat">${esc(r.material)}</span>${matchTag(r)}
          <div class="rspool">${r.spool_name ? esc(r.spool_name)
            : `<select class="rmap" data-hex="${esc(r.color_hex)}">${spoolOptions(null)}</select>`}</div>
          </div></div></td>
        <td class="num" data-label="Needed">${g(r.needed_g)}</td>
        <td class="num" data-label="On hand">${onHand}</td>
        <td class="num" data-label="Short">${r.shortfall_g == null ? "—" : (r.shortfall_g > 0 ? g(r.shortfall_g) : "0")}</td>
        <td class="num" data-label="Rolls">${r.rolls_to_buy == null ? "—" : r.rolls_to_buy}</td>
        <td class="num" data-label="$/roll">${price}</td>
        <td class="num" data-label="Est. cost">${r.est_cost == null ? (r.no_price ? `<span class="rhex">no price</span>` : "—") : money(r.est_cost)}</td>
        <td class="hide">${buy}</td>
      </tr>`;
    }).join("");

    $$("#res-body").innerHTML = `<div class="rscroll"><table class="rtab">
      <thead><tr>
        <th>Material</th><th>Colour</th>
        <th class="num">Needed</th><th class="num">On hand</th><th class="num">Short</th>
        <th class="num">Rolls</th><th class="num">$/roll</th><th class="num">Est. cost</th><th class="hide"></th>
      </tr></thead><tbody>${body}</tbody></table></div>`;
    wire();
  }

  function wire() {
    // (The Buy/Search control is a real <a target="_blank"> since v2.20 — no
    //  handler needed, and no popup blocker to swallow it.)

    // Inline edit for both inventory fields. Swaps the button for a number
    // input in place; Enter or blur commits, Escape reverts. No modal — these
    // are numbers you correct a dozen times while standing at the shelf, and on
    // a phone a modal per value would make filling in 11 spools a chore nobody
    // finishes. Blank clears back to unset rather than storing 0: "I don't
    // know" and "none left" are different answers.
    EL.querySelectorAll("[data-inv]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.inv, k = b.dataset.k;
      if (!id) return;
      const cur = SPOOLS.find(s => s.id === id);
      const inp = document.createElement("input");
      inp.className = "redit editing";
      inp.type = "number"; inp.min = "0";
      inp.step = k === "cost_per_roll" ? "0.01" : "10";
      inp.value = cur && cur[k] != null ? cur[k] : "";
      inp.placeholder = k === "cost_per_roll" ? "per roll" : "grams";
      inp.setAttribute("inputmode", "decimal");   // phone keypad, not the alpha keyboard
      b.replaceWith(inp); inp.focus(); inp.select();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        const v = inp.value.trim();
        await jpost("/api/resources/inventory", { spool_id: id, [k]: v === "" ? null : Number(v) });
        load();
      };
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        if (e.key === "Escape") { done = true; render(); }
      });
      inp.addEventListener("blur", commit);
    }));

    EL.querySelectorAll("select.rmap").forEach(sel => sel.addEventListener("change", async () => {
      await jpost("/api/resources/map", { color_hex: sel.dataset.hex, spool_id: sel.value || null });
      load();
    }));
  }

  function renderFoot() {
    const T = DATA.totals, bits = [];
    bits.push(`${DATA.counted_jobs} job${DATA.counted_jobs === 1 ? "" : "s"} counted
      (queued, printing and paused), ${DATA.cache_entries} file${DATA.cache_entries === 1 ? "" : "s"} parsed`);
    if (T.unpriced_rows) bits.push(`${T.unpriced_rows} row${T.unpriced_rows > 1 ? "s" : ""}
      excluded from the total — no cost per roll set on that spool`);
    if (T.unassigned) bits.push(`${T.unassigned} colour${T.unassigned > 1 ? "s" : ""}
      not matched to any spool — still counted in "needed"`);
    if (T.review) bits.push(`${T.review} nearest-colour match${T.review > 1 ? "es" : ""} worth reviewing`);
    bits.push(`purge is already inside these numbers — the slicer charges flush to the
      slot doing it, so nothing is added on top`);
    $$("#res-foot").innerHTML = bits.join(" &middot; ");
  }

  async function onShow() {
    // On a phone the core stacks the file list ABOVE every module view, so
    // tapping a tab lands you at the top of the library, not at the thing you
    // tapped. Bring the section to the top of the viewport instead. This is
    // deliberately local to this module — the global fix would be a layout
    // change to the core page, and document-root layout edits have burned this
    // project before (MISTAKES.md, 2026-08-30).
    try {
      if (window.matchMedia && window.matchMedia("(max-width:880px)").matches)
        EL.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {}
    await load();
  }

  window.HubModules.register("resources", { tab: "Resources", mount, onShow });

  // ---- Schedule badge -------------------------------------------------------
  // "N colours short" on the Dispatch tab, linking here. Same server code path
  // as the table (/api/resources/badge calls the identical compute), so the
  // badge can never claim something the tab contradicts.
  async function paintBadge() {
    let b; try { b = await jget("/api/resources/badge"); } catch { return; }
    if (!b || b.off) return;
    const n = b.short || 0, un = b.unresolved || 0;
    document.querySelectorAll('.vtab[data-view="dispatch"]').forEach(tab => {
      let dot = tab.querySelector(".resbadge");
      if (!n && !un) { if (dot) dot.remove(); return; }
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "resbadge";
        dot.style.cssText = "margin-left:7px;padding:1px 6px;border-radius:9px;font-size:10px;" +
          "font-weight:700;background:var(--bad);color:#fff;cursor:pointer";
        dot.addEventListener("click", e => { e.stopPropagation(); setView("resources"); });
        tab.appendChild(dot);
      }
      dot.textContent = n ? n + " short" : un + " unread";
      dot.title = n ? n + " colour(s) short for the current schedule"
                    : un + " scheduled job(s) whose gcode could not be read";
    });
  }
  setTimeout(paintBadge, 1500);
  setInterval(paintBadge, 60000);
})();
