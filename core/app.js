// core/app.js — the Express app: middleware, auth, tunnel, page server, static files
// Split out of server.js (v2.23). Loads in the original order through the
// shared `hub`; see server.js for the sequence. Behavior-preserving move.
const express = require("express");
const fs = require("fs");
const path = require("path");

module.exports = function (hub) {
const { ASSET_DIR, BASE_DIR, PORT, VERSION, typeBySlug, typeFolder } = hub;


const app = express();

// v2.23 PERF DIAGNOSIS: a request timeline. Every request appends one line
// (arrival time, client, method, url, status, server ms, bytes) to a small
// buffer flushed to BASE_DIR/access.log every 5 s. The point is to see a real
// phone-on-cellular page load the way the server saw it - which requests, in
// what order, how long each took HERE - instead of simulating one. Cheap:
// one string per request, one file append every few seconds. The file is
// state (gitignored), capped at ~2 MB by truncation.
{
  const ACCESS_LOG = path.join(BASE_DIR, "access.log");
  let buf = [];
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
      const ip = String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
      buf.push(new Date(t0).toISOString() + " " + ip + " " + req.method + " " + req.originalUrl.slice(0, 120) +
               " " + res.statusCode + " " + (Date.now() - t0) + "ms " + (res.getHeader("content-length") || "-"));
    });
    next();
  });
  const flush = setInterval(() => {
    if (!buf.length) return;
    const lines = buf.join("\n") + "\n"; buf = [];
    try {
      let st = null; try { st = fs.statSync(ACCESS_LOG); } catch {}
      if (st && st.size > 2 * 1024 * 1024) fs.writeFileSync(ACCESS_LOG, lines); else fs.appendFileSync(ACCESS_LOG, lines);
    } catch {}
  }, 5000);
  if (flush.unref) flush.unref();
}

// v2.21: everything under PRINTER_PROXY_PREFIX is a byte-for-byte relay to a
// printer's own web server (modules/klipper.js) and must NOT have its body
// consumed here. express.json() reads the stream to parse it; once it has, the
// proxy has nothing left to forward, and a Moonraker POST arrives empty. The
// prefix is named in core rather than owned by the module because this is a
// decision about the request pipeline, which is core's to make — the module
// imports the same constant so the two can never disagree.
const PRINTER_PROXY_PREFIX = "/p/";

const jsonBody = express.json({ limit: "1mb" });

app.use((req, res, next) =>
  req.path.startsWith(PRINTER_PROXY_PREFIX) ? next() : jsonBody(req, res, next));

// Access gate — fronts everything below (static included). Modes and the
// off-switch live in auth.json; see auth.js for the design notes.
// The returned isAuthed() is handed to modules that must gate a WebSocket
// upgrade, which never passes through Express middleware.
const AUTH = require("../auth.js")(app, express, BASE_DIR, ASSET_DIR);

// Remote access — Hub-managed Cloudflare tunnel (see tunnel.js design notes).
// Mounted after the gate so every /api/tunnel/* route requires login.
require("../tunnel.js")(app, express, BASE_DIR, PORT);

// v2.11: the dashboard is served through a tiny feature-aware transform.
// Three jobs, all textual, no template engine:
//   1. Inject the live feature map as window.HUB_FEATURES (race-free — the
//      client never has to fetch before knowing what exists).
//   2. Strip the nav for disabled client features (Spool Match / Spools tabs,
//      the FS Mixer link) so a gated feature isn't a dead button — the served
//      page simply doesn't have it. The Lite profile is this, applied.
//   3. Inject <script> tags for client module files (CLIENT_TABLE) — the
//      browser-side twin of MODULE_TABLE. Dispatch is its first entry; the
//      list is static for the same pkg reason as the server table.
const CLIENT_TABLE = {
  dispatch: "/modules/dispatch-ui.js",  // public/modules/dispatch-ui.js, static-served
  slicing: "/modules/slicing-ui.js",    // v2.12 Slice tab, same pattern
  resources: "/modules/resources-ui.js", // v2.16 Resources tab
  updates: "/modules/updates-ui.js",     // v2.18 version chip in the topbar (no tab)
  spoolman: "/modules/spoolman-ui.js",   // v2.24 import card on the Spools tab (no tab)
  notify: "/modules/notify-ui.js",       // v2.24 ntfy card in Settings (no tab)
  advisor: "/modules/advisor-ui.js"      // v2.25 AI pre-flight: Settings block + job-card button (no tab)
  // (named -ui deliberately: the server module is modules/dispatch.js, and two
  //  same-named files in different folders is a foot-gun during deploys)
};

// v2.23: the ?v= stamp is VERSION plus a content hash of the stamped assets,
// computed once at boot. Found live on Danny's phone 2026-09-08: the assets
// are cached immutable for a year (below), so between RELEASES every edit to
// app.js was invisible to a browser that had already loaded 2.23.0 - the
// tangle-reason line shipped, the server said it, and the card never drew
// it. A version number changes once a release; the files change all week.
// Same stamp for the whole set, so one restart moves every URL together.
const ASSET_STAMP = (() => {
  try {
    const h = require("crypto").createHash("sha1");
    const files = ["app.js", "gold.css", ...Object.values(CLIENT_TABLE).map(s => s.replace(/^\//, ""))];
    for (const f of files) { try { h.update(fs.readFileSync(path.join(ASSET_DIR, "public", f))); } catch {} }
    return VERSION + "-" + h.digest("hex").slice(0, 8);
  } catch { return VERSION; }
})();

function serveIndex(req, res) {
  try {
    let html = fs.readFileSync(path.join(ASSET_DIR, "public", "index.html"), "utf8");
    html = html.replace("<!-- @hub-features -->",
      "<script>window.HUB_FEATURES = " + JSON.stringify(hub.FEATURES) + ";</script>");
    if (hub.FEATURES.match === false)
      html = html.replace(/<button class="vtab" data-view="match">[^<]*<\/button>/g, "");
    if (hub.FEATURES.spools === false)
      html = html.replace(/<button class="vtab" data-view="spools">[^<]*<\/button>/g, "");
    if (hub.FEATURES.mixer === false)
      html = html.replace(/<a class="gear" href="\/fs-colors\.html"[^>]*>[^<]*<\/a>/g, "");
    // v2.21: every asset URL the page loads carries ?v=<VERSION>. Found live on
    // Danny's phone the hour v2.21 shipped: index.html refreshed (the badge
    // said 2.21.0) while the Resources tab still ran the 2.20 resources-ui.js
    // from the browser's HTTP cache — express.static sends no Cache-Control,
    // so mobile browsers cache heuristically, and a pull-to-refresh revalidates
    // the page but not the scripts it names. A versioned URL is a different URL
    // after every release: the old cache entry simply never matches again, and
    // between releases the cache is free to do its job.
    const tags = Object.entries(CLIENT_TABLE)
      .filter(([name]) => hub.FEATURES[name] !== false)
      .map(([, src2]) => '<script src="' + src2 + '?v=' + ASSET_STAMP + '"></script>').join("\n");
    html = html.replace("<!-- @client-modules -->", tags);
    html = html.replace('href="gold.css"', 'href="gold.css?v=' + ASSET_STAMP + '"');
    // v2.23 PERF: the application script lives in app.js now, stamped the same
    // way, so a phone caches it (compiled) between releases and never re-parses
    // 2,600 lines of inline script on every visit.
    html = html.replace('src="app.js"', 'src="app.js?v=' + ASSET_STAMP + '"');
    // And the page itself must always revalidate — the version stamp on the
    // assets is useless if the HTML that carries it can go stale.
    res.set("Cache-Control", "no-cache");
    res.type("html").send(html);
  } catch (e) { res.status(500).send("index.html not found"); }
}

app.get("/", serveIndex);

app.get("/index.html", serveIndex);   // close the raw-file side door too


// v2.23 PERF: express.static sends no Cache-Control, so phones re-fetched the
// module scripts (140 KB+) and the stylesheet on most visits. Every one of
// those URLs carries ?v=<VERSION> (see serveIndex), which makes it a different
// URL every release - so between releases it can be cached for a year and the
// browser never spends a tunnel round trip asking. Fonts and icons have no
// stamp and change about never; a day is plenty. index.html itself never
// comes through here (serveIndex, no-cache) so the version stamp stays fresh.
app.use(express.static(path.join(ASSET_DIR, "public"), { index: false, setHeaders: (res, filePath) => {
  const q = (res.req && res.req.query) || {};
  if (q.v) res.set("Cache-Control", "public, max-age=31536000, immutable");
  else if (/\.(woff2?|ttf|png|ico|svg|webmanifest|json)$/i.test(filePath)) res.set("Cache-Control", "public, max-age=86400");
} }));

// FS mix planner: same explicit-route treatment for the packaged binary, then
// the module mounts /api/fs-colors/analyze and /api/fs-colors/solve.
app.get("/fs-colors.html", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "fs-colors.html"), "utf8")); }
  catch (e) { res.status(500).send("fs-colors.html not found"); }
});

// QR spool labels (v2.9): printable sheet, same packaged-binary treatment.
app.get("/labels.html", (req, res) => {
  try { res.type("html").send(fs.readFileSync(path.join(ASSET_DIR, "public", "labels.html"), "utf8")); }
  catch (e) { res.status(500).send("labels.html not found"); }
});

// fs-colors mount moved to modules/mixer.js (v2.11). The fs-colors.html PAGE
// stays core-served (express.static covers it anyway); only the /api/fs-colors
// routes are feature-gated.
// RFID / spool identity (v2.9): hub-side tag scanning → spool_id → filament
// identity, backed by the bundled FilamentColors.xyz snapshot. Printers never
// read tags for this feature; see rfid.js design notes.
// rfid mount moved to modules/spools.js (v2.11). Same page-vs-API split:
// labels.html stays served, /api/spools + /api/slots exist only when enabled.

// Resolve a requested filename safely INSIDE a type's bound folder (no
// traversal). Same basename-only discipline as always — the type only selects
// WHICH locked folder, so safeFile coverage is unchanged in kind.
function safeFile(name, t) {
  if (!name) return null;
  const dir = typeFolder(t || typeBySlug("u1"));
  const p = path.resolve(dir, path.basename(name));
  return p.startsWith(dir + path.sep) || path.dirname(p) === dir ? p : null;
}

// Resolve the ?type= / body.type param to a validated type record (default U1).
function reqTypeOf(req) {
  const slug = String((req.query && req.query.type) || ((req.body || {}).type) || "").trim();
  if (!slug) return typeBySlug("u1") || hub.TYPES[0];
  return typeBySlug(slug) || null;
}

Object.assign(hub, { AUTH, PRINTER_PROXY_PREFIX, app, reqTypeOf, safeFile });
};
