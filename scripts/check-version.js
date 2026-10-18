#!/usr/bin/env node
// scripts/check-version.js - the tag must equal what the code says it is (F10, 2.45)
//
//   node scripts/check-version.js v2.45.0
//
// Exits 0 when the tag's version equals package.json "version", server.js
// VERSION and the first "### X.Y.Z" heading in docs/CHANGELOG.md; exits 1
// with every mismatch named. CI runs it on tag builds before anything is
// published, so a tag that lies about the release cannot ship. Exported for
// the harness.
"use strict";
const fs = require("fs");
const path = require("path");

function readVersions(repo) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  const srv = (fs.readFileSync(path.join(repo, "server.js"), "utf8").match(/const VERSION = "([^"]+)"/) || [])[1];
  const log = (fs.readFileSync(path.join(repo, "docs", "CHANGELOG.md"), "utf8").match(/^### (\d+\.\d+\.\d+)/m) || [])[1];
  return { pkg, srv, log };
}

function checkVersion(tag, versions) {
  const v = String(tag || "").replace(/^refs\/tags\//, "").replace(/^v/, "");
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(v)) problems.push("tag \"" + tag + "\" is not vX.Y.Z");
  if (versions.pkg !== v) problems.push("package.json says " + versions.pkg);
  if (versions.srv !== v) problems.push("server.js VERSION says " + versions.srv);
  if (versions.log !== v) problems.push("docs/CHANGELOG.md's first heading says " + versions.log);
  return { ok: problems.length === 0, version: v, problems };
}

if (require.main === module) {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
  const r = checkVersion(tag, readVersions(path.resolve(__dirname, "..")));
  if (r.ok) { console.log("version " + r.version + " matches package.json, server.js and CHANGELOG"); process.exit(0); }
  console.error("tag " + tag + " does not match the code: " + r.problems.join("; "));
  process.exit(1);
}

module.exports = { checkVersion, readVersions };
