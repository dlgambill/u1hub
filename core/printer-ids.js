// core/printer-ids.js - stable printer identity (2.43, H2).
//
// A printer's POSITION in config.json's printers array is not who it is:
// Settings rebuilds the array in whatever order the form sends, so anything
// keyed by position (Dispatch claims, maintenance, pins) used to land on a
// different machine after a reorder. Each printer now carries an `id` that
// is minted once and never changes; state that must follow the machine is
// keyed by it. Pure functions, so the harness and a migration dry run can
// use exactly what the Hub uses.
"use strict";

const crypto = require("crypto");

const newPrinterId = () => "p" + crypto.randomBytes(5).toString("hex");
const looksLikeId = v => typeof v === "string" && /^p[0-9a-f]{6,}$/.test(v);

// Give every printer without a valid, unique id a new one. Returns how many
// were added (0 = nothing changed, no need to save).
function ensurePrinterIds(printers) {
  const seen = new Set();
  let added = 0;
  for (const p of printers || []) {
    if (!p || typeof p !== "object") continue;
    if (!looksLikeId(p.id) || seen.has(p.id)) { p.id = newPrinterId(); added++; }
    seen.add(p.id);
  }
  return added;
}

// Which id a printer record from the Settings form keeps. The page sends the
// id it was given; an older page sends none, so fall back to the existing
// printer at the same address. Anything else is a new printer.
function idForIncoming(incoming, existing, taken) {
  const known = (existing || []).filter(p => p && looksLikeId(p.id));
  if (looksLikeId(incoming.id) && known.some(p => p.id === incoming.id) && !taken.has(incoming.id)) return incoming.id;
  const byUrl = known.find(p => p.url === incoming.url && !taken.has(p.id));
  if (byUrl) return byUrl.id;
  let id = newPrinterId();
  while (taken.has(id)) id = newPrinterId();
  return id;
}

module.exports = { newPrinterId, looksLikeId, ensurePrinterIds, idForIncoming };
