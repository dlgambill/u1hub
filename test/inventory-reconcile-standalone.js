// test/inventory-reconcile-standalone.js — v2.20
//
// The rule under test: deleting filament from the library must not leave a
// notice behind, and must not quietly eat numbers that something still points
// at (or numbers we only THINK are stranded because a file failed to read).
//
// Run: node test/inventory-reconcile-standalone.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../modules/resources.js");

let pass = 0, fail = 0;
const logs = [];
const hublog = (lvl, msg) => logs.push(lvl + ": " + msg);
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  " + JSON.stringify(extra))); }
}
function fakeStore(state) {
  let saves = 0;
  return { state, save() { saves++; }, get saves() { return saves; } };
}

console.log("\n== inventory reconcile: a deleted roll leaves nothing behind ==");

// 1. The live case. sp_gone is not on the shelf and no colour maps to it.
{
  const st = fakeStore({
    inv: { sp_here: { remaining_g: 800 }, sp_gone: { remaining_g: 600, cost_per_roll: 25 } },
    color_map: { "#000000": "sp_here" }
  });
  const kept = R.reconcileInventory(hublog, st, new Set(["sp_here"]), true);
  ok(!("sp_gone" in st.state.inv), "an unreferenced entry for a deleted spool is removed");
  ok("sp_here" in st.state.inv, "…and the live spool's numbers are untouched");
  ok(kept.length === 0, "…and nothing is reported, so no banner can render", kept);
  ok(st.saves === 1, "…and the change is persisted exactly once", st.saves);
  ok(logs.some(l => l.includes("sp_gone") && l.includes("600 g") && l.includes("25")),
    "…and the grams and price go to the log, so the number is recoverable", logs);
}

// 2. Falsification: with the reconcile removed, (1) is the ONLY thing that
//    changes. Prove the opposite branch by making the same entry referenced.
{
  const st = fakeStore({
    inv: { sp_gone: { remaining_g: 600, cost_per_roll: 25 } },
    color_map: { "#FF0000": "sp_gone" }
  });
  const kept = R.reconcileInventory(hublog, st, new Set(["sp_here"]), true);
  ok("sp_gone" in st.state.inv, "an entry a colour still maps to is NOT deleted");
  ok(kept.length === 1 && kept[0].spool_id === "sp_gone",
    "…it is reported instead, so the mapping can be repointed", kept);
  ok(st.saves === 0, "…and nothing is written when nothing was dropped", st.saves);
}

// 3. The share-failure guard. A shelf we could not read is not evidence.
{
  const st = fakeStore({ inv: { a: { remaining_g: 1 }, b: { remaining_g: 2 } }, color_map: {} });
  const kept = R.reconcileInventory(hublog, st, new Set(), false);
  ok(Object.keys(st.state.inv).length === 2,
    "a non-authoritative shelf deletes nothing — one EIO must not wipe the inventory", st.state.inv);
  ok(kept.length === 0,
    "…and it does not accuse either: every row would look orphaned, which is noise not news", kept);
}

// 4. Numeric ids from the manual "New roll" path are strings in color_map on
//    one side and numbers on the other. A type mismatch here would delete a
//    referenced row.
{
  const st = fakeStore({ inv: { "-101": { remaining_g: 400 } }, color_map: { "#00FF00": -101 } });
  R.reconcileInventory(hublog, st, new Set(["sp_x"]), true);
  ok("-101" in st.state.inv, "a numeric spool id in color_map still counts as a reference");
}

// 5. Empty everything is not a crash and not a save.
{
  const st = fakeStore({});
  const kept = R.reconcileInventory(hublog, st, new Set(), true);
  ok(kept.length === 0 && st.saves === 0, "no inventory at all is a no-op");
}

console.log("\n== readShelf: is an empty shelf a fact or a failed read? ==");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "u1shelf-"));
  const store = fakeStore({ inv: {} });
  const meta = {};

  R.readShelf(dir, store, meta);
  ok(meta.authoritative === true, "no spools.json at all: nothing has ever been shelved — authoritative");

  fs.writeFileSync(path.join(dir, "spools.json"), '{"spools":{}}');
  R.readShelf(dir, store, meta);
  ok(meta.authoritative === true, "spools.json with an empty spools{}: an authoritative empty shelf");

  fs.writeFileSync(path.join(dir, "spools.json"), '{"spools":{"sp_a":{"hex":"#000000"}}}');
  const shelf = R.readShelf(dir, store, meta);
  ok(meta.authoritative === true && shelf.length === 1, "a normal shelf reads authoritative", shelf.length);

  fs.writeFileSync(path.join(dir, "spools.json"), '{"spools":{"sp_a":');
  R.readShelf(dir, store, meta);
  ok(meta.authoritative === false, "a half-written spools.json is NOT authoritative — this is the delete guard");

  fs.writeFileSync(path.join(dir, "spools.json"), '{"local":[{"id":-1}]}');
  R.readShelf(dir, store, meta);
  ok(meta.authoritative === false, "a file with no spools{} key at all is not authoritative either");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
