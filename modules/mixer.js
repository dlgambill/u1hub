// modules/mixer.js — FS Mix Planner (v2.11 module). The solver/analyzer lives
// in fs-colors.js exactly as shipped; this module is the feature-gated mount.
// The fs-colors.html page stays core-served; the /api/fs-colors routes exist
// only when the flag is on.

"use strict";

function register(ctx) {
  require("../fs-colors.js")(ctx.app, ctx.express);
}

module.exports = { register };
