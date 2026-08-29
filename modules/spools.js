// modules/spools.js — spool identity / RFID / QR / loadout (v2.11 module).
// The engine itself lives in rfid.js exactly as it shipped in 2.9/2.10; this
// module is the feature-gated mount. Page files (labels.html) stay core-served;
// only the /api/spools + /api/slots surface appears and disappears with the
// flag. Core's filament memory reads slots.json/spools.json via a read-only
// disk peek by design, so it keeps working (returning what was last recorded)
// whether or not this module is mounted.

"use strict";

function register(ctx) {
  require("../rfid.js")(ctx.app, ctx.express, ctx.baseDir, ctx.assetDir, {
    getPrinters: () => ctx.printers,
    getCaps: (idx) => ctx.detectCaps(idx),
    log: ctx.hublog
  });
}

module.exports = { register };
