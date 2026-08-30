// test/slicing-standalone.js — v2.12 slicing verification, self-contained.
// Runs WITHOUT the full Hub file set: exercises the pure transplant engine on
// the REAL fixture bytes (test/fixtures/cube-u1.3mf + ag-u1o.3mf), then boots
// the slicing module on a bare express app with a stub ctx and drives the
// /api/slice queue against mock-orca-cli.js in all four failure/success modes.
// The same checks ship inside run-tests.js as the SLICE section; this file
// exists so the engine can be proven even where auth.js/tunnel.js aren't
// staged (cloud build sessions).
// Run: node test/slicing-standalone.js
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const S = require("../modules/slicing.js");

let PASS = 0, FAIL = 0;
function ok(cond, name, detail) {
  if (cond) { PASS++; console.log("  ✓ " + name); }
  else { FAIL++; console.log("  ✗ " + name + (detail !== undefined ? "  → " + JSON.stringify(detail).slice(0, 300) : "")); }
}
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FIX = path.join(__dirname, "fixtures");
const CUBE = path.join(FIX, "cube-u1.3mf");
const AG = path.join(FIX, "ag-u1o.3mf");
if (!fs.existsSync(CUBE) || !fs.existsSync(AG)) {
  console.error("Fixtures missing. Copy cube-u1.3mf and ag-u1o.3mf into test/fixtures/ (gitignored).");
  process.exit(1);
}

(async () => {
  const cube = fs.readFileSync(CUBE), ag = fs.readFileSync(AG);

  console.log("\n== SLICE-E: transplant engine on real bytes ==");
  {
    const dc = S.detect3mf(S.zipRead(cube));
    ok(dc.native === true && dc.reasons.length === 0, "cube-u1 detected native (auto mode would NOT transplant)", dc.reasons);
    const da = S.detect3mf(S.zipRead(ag));
    ok(da.native === false && da.reasons.some(r => /embedded project preset/.test(r)),
      "ag-u1o detected poisoned via embedded-preset ids despite printer_model=U1", da.reasons);

    const t = S.u1ify(ag, cube);
    const outE = S.zipRead(t.buffer);
    const inE = S.zipRead(ag);
    const byName = arr => new Map(arr.map(e => [e.name, e]));
    const O = byName(outE), I = byName(inE);

    // project_settings: exactly the template's (padded) serialization
    const wantPs = JSON.stringify(S.padFilamentArrays(JSON.parse(
      S.zipEntryContent(S.zipRead(cube).find(e => e.name === "Metadata/project_settings.config")).toString("utf8"))), null, 4);
    ok(S.zipEntryContent(O.get("Metadata/project_settings.config")).toString("utf8") === wantPs,
      "project_settings.config replaced with template settings, byte-exact");
    const psOut = JSON.parse(wantPs);
    ok(["filament_colour", "filament_type", "filament_diameter"].every(k => (psOut[k] || []).length === 4),
      "filament_* arrays are length 4 after transplant");
    ok(!/\.3mf\)/.test(JSON.stringify(psOut.filament_settings_id) + psOut.print_settings_id),
      "embedded-preset references gone from transplanted settings");

    // geometry: original compressed bytes verbatim (crc AND raw identical)
    const geoName = inE.map(e => e.name).find(n => n.startsWith("3D/Objects/"));
    ok(O.get(geoName) && O.get(geoName).crc === I.get(geoName).crc && sha(O.get(geoName).raw) === sha(I.get(geoName).raw),
      "geometry member passes through byte-verbatim (28 MB untouched, not recompressed)", geoName);
    for (const n of ["Metadata/plate_1.png", "_rels/.rels", "[Content_Types].xml"])
      ok(sha(O.get(n).raw) === sha(I.get(n).raw), "passthrough byte-verbatim: " + n);

    // stale members would be stripped (synthesize one to prove the rule fires)
    const withStale = S.zipWrite([...inE, { name: "Metadata/machine_settings_1.config", method: 0,
      crc: 0, csize: 4, usize: 4, raw: Buffer.from("junk") }]);
    // fix crc for validity
    const staleE = S.zipRead(withStale); // reread ok even with crc 0 (we don't verify crc on read)
    const t2 = S.u1ify(withStale, cube);
    ok(!S.zipRead(t2.buffer).some(e => /machine_settings_/.test(e.name)) &&
       t2.changed.some(c => /stripped/.test(c)),
      "stale machine_settings_* member stripped, and said so", t2.changed);

    // extruder remap: synthesize an out-of-range id
    const msIdx = inE.findIndex(e => e.name === "Metadata/model_settings.config");
    const msXml = S.zipEntryContent(inE[msIdx]).toString("utf8").replace('key="extruder" value="1"', 'key="extruder" value="7"');
    const mutated = inE.slice(); const cont = Buffer.from(msXml, "utf8");
    mutated[msIdx] = { name: inE[msIdx].name, method: 0, crc: 0, csize: cont.length, usize: cont.length, raw: cont };
    const t3 = S.u1ify(S.zipWrite(mutated), cube);
    const msOut = S.zipEntryContent(S.zipRead(t3.buffer).find(e => e.name === "Metadata/model_settings.config")).toString("utf8");
    ok(/key="extruder" value="1"/.test(msOut) && !/value="7"/.test(msOut) && t3.changed.some(c => /remapped/.test(c)),
      "out-of-range object extruder id remapped into 1..4", t3.changed);

    // idempotence: transplanting the transplant changes nothing further
    const tt = S.u1ify(t.buffer, cube);
    ok(sha(tt.buffer) === sha(S.u1ify(t.buffer, cube).buffer) &&
       S.zipRead(tt.buffer).every(e => { const m = S.zipRead(t.buffer).find(x => x.name === e.name); return m && sha(e.raw) === sha(m.raw); }),
      "transplant is idempotent (second pass is a byte no-op per member)");

    // the result is a well-formed zip a slicer can open
    ok(S.zipRead(t.buffer).length === inE.length, "member count preserved (nothing lost, nothing stale to strip in ag-u1o)");
  }

  console.log("\n== SLICE-Q: /api/slice queue against the mock CLI ==");
  {
    let express;
    try { express = require("express"); }
    catch { console.log("  (express not installed here — queue section runs inside run-tests.js on the staged Hub)"); report(); return; }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u1slice-sa-"));
    const base = path.join(tmp, "base"); fs.mkdirSync(base);
    const gdir = path.join(tmp, "gcode"); fs.mkdirSync(gdir);
    const src = path.join(base, "3mf"); fs.mkdirSync(src);
    fs.copyFileSync(CUBE, path.join(base, "slicer-template.3mf"));
    fs.copyFileSync(CUBE, path.join(src, "cube.3mf"));
    fs.copyFileSync(AG, path.join(src, "ag.3mf"));
    fs.writeFileSync(path.join(src, "junk.3mf"), "not a zip");

    const mockCli = path.join(__dirname, "mock-orca-cli.js");
    let MODE = "ok";
    let SAVED = 0;
    // prefixArgs as a live getter must survive the config route replacing the
    // slicer object — so the getter rides on the OBJECT the route builds from.
    const mkSlicer = extra => Object.defineProperty({ exe: process.execPath, timeoutMs: 20000, ...extra },
      "prefixArgs", { get() { return [mockCli, MODE]; }, enumerable: true });
    const CFGOBJ = { slicer: mkSlicer({}) };
    const logs = [];
    const app = express(); app.use(express.json());
    const ctx = {
      app, express, hublog: (lv, m) => logs.push(lv + ": " + m),
      baseDir: base, assetDir: base,
      gcodeFolderFor: () => gdir,
      fileInfo: (name) => {
        const p = path.join(gdir, name);
        if (!fs.existsSync(p)) return { exists: false };
        const m = /estimated printing time[^=]*=\s*(?:(\d+)h )?(\d+)m/.exec(fs.readFileSync(p, "utf8"));
        return { exists: true, estMinutes: m ? (+(m[1] || 0)) * 60 + +m[2] : null, colors: [], multi: false };
      },
      get cfg() { return CFGOBJ; }, get printers() { return []; }, get types() { return []; }, get features() { return {}; },
      loadout: () => null, spoolShelf: () => ({}), fleet: () => ({}), detectCaps: () => null,
      provide: () => {}, use: () => undefined, saveConfig: () => { SAVED++; CFGOBJ.slicer = mkSlicer(CFGOBJ.slicer); }
    };
    S.register(ctx);
    const srv = await new Promise(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    const HUB = "http://127.0.0.1:" + srv.address().port;
    const jget = async p => { const r = await fetch(HUB + p); return { status: r.status, body: await r.json().catch(() => null) }; };
    const jpost = async (p, b) => { const r = await fetch(HUB + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
    const waitJob = async id => { for (let i = 0; i < 80; i++) { const r = await jget("/api/slice/jobs"); const j = (r.body.jobs || []).find(x => x.id === id); if (j && (j.state === "done" || j.state === "error")) return j; await sleep(150); } throw new Error("job " + id + " never settled"); };

    let r = await jget("/api/slice/status");
    ok(r.status === 200 && r.body.exeFound === true && r.body.templateFound === true, "status: exe + template found", r.body);
    r = await jget("/api/slice/files");
    ok(r.status === 200 && r.body.files.length === 3 && r.body.files.every(f => f.file.endsWith(".3mf")), "library lists the 3 fixtures", r.body.files);
    r = await jget("/api/slice/inspect?file=ag.3mf");
    ok(r.status === 200 && r.body.native === false, "inspect: ag flagged for transplant", r.body);
    r = await jget("/api/slice/inspect?file=../../../etc/passwd");
    ok(r.status === 404, "inspect: path traversal rejected", r.status);

    // ok mode, native file: no transplant, gcode lands, est parsed
    r = await jpost("/api/slice", { file: "cube.3mf", type: "u1" });
    ok(r.status === 200, "enqueue accepted", r.body);
    let j = await waitJob(r.body.job.id);
    ok(j.state === "done" && j.transplanted === false && j.gcodeName === "cube.gcode" &&
       fs.existsSync(path.join(gdir, "cube.gcode")) && j.estMinutes === 90,
      "native file: sliced without transplant, gcode in folder, est 90m", j);

    // ok mode, poisoned file: auto-transplant fires and says why
    r = await jpost("/api/slice", { file: "ag.3mf", type: "u1" });
    j = await waitJob(r.body.job.id);
    ok(j.state === "done" && j.transplanted === true && j.changed.length > 0 && j.detectedReasons.length > 0,
      "poisoned file: auto U1-ify, reasons + change manifest surfaced", { d: j.detectedReasons, c: j.changed });
    ok(fs.existsSync(path.join(gdir, "ag.gcode")), "second gcode landed under its own name");
    r = await jpost("/api/slice", { file: "cube.3mf", type: "u1" });
    j = await waitJob(r.body.job.id);
    ok(j.gcodeName === "cube-2.gcode", "name collision → -2 suffix, nothing overwritten", j.gcodeName);

    // the three failure shapes, honestly reported
    MODE = "silent";
    r = await jpost("/api/slice", { file: "cube.3mf", type: "u1" });
    j = await waitJob(r.body.job.id);
    ok(j.state === "error" && j.exitCode === 5 && /no output captured/.test(j.error),
      "silent crash: nonzero exit + empty log called out as a hard crash", j.error);
    MODE = "honest";
    r = await jpost("/api/slice", { file: "cube.3mf", type: "u1" });
    j = await waitJob(r.body.job.id);
    ok(j.state === "error" && /filament_is_high_temperature/.test(j.logTail),
      "honest CLI error: stderr surfaced in the job log", j.logTail);
    MODE = "eaten";
    r = await jpost("/api/slice", { file: "cube.3mf", type: "u1" });
    j = await waitJob(r.body.job.id);
    ok(j.state === "error" && /exited 0 but produced no gcode/.test(j.error) && /GUI/.test(j.hint || ""),
      "exit-0-no-gcode: flagged with the single-instance-forwarding hint", { e: j.error, h: j.hint });
    MODE = "ok";

    // guard rails
    r = await jpost("/api/slice", { file: "nope.3mf" });
    ok(r.status === 404, "unknown file → 404", r.status);
    r = await jpost("/api/slice", { file: "../server.js" });
    ok(r.status === 400, "traversal/non-3mf → 400", r.status);
    r = await jpost("/api/slice", { file: "junk.3mf", transplant: "always" });
    j = await waitJob(r.body.job.id);
    ok(j.state === "error", "non-zip .3mf fails in preparing, not mid-slice", j.error);

    // -- settings + copies through the queue (v2.12 tranche 4) --
    r = await jpost("/api/slice", { file: "cube.3mf", type: "u1",
      settings: { layer_height: 0.3, sparse_infill_density: 30, enable_support: true }, copies: 3 });
    ok(r.status === 200, "enqueue with settings + copies accepted", r.body);
    j = await waitJob(r.body.job.id);
    ok(j.state === "done" && j.applied &&
       j.applied.layer_height.ok && j.applied.layer_height.applied === "0.3" &&
       j.applied.sparse_infill_density.ok && j.applied.enable_support.ok,
      "settings: flags reached the CLI and echoed back applied", j.applied);
    ok(j.copies === 3 && j.changed.some(c => /cloned .*×3/.test(c)),
      "copies: clone stage ran in the pipeline", j.changed);
    const gTail = fs.readFileSync(path.join(gdir, j.gcodeName), "utf8");
    ok(/--arrange 1/.test(gTail) && /--layer-height 0.3/.test(gTail),
      "CLI received --arrange 1 (forced by clones) and the setting flags", /; args = ([^\n]*)/.exec(gTail)[1]);
    MODE = "deaf";
    r = await jpost("/api/slice", { file: "cube.3mf", settings: { layer_height: 0.3 } });
    j = await waitJob(r.body.job.id);
    ok(j.state === "done" && j.applied.layer_height.ok === false && j.applied.layer_height.applied === "0.2",
      "deaf slicer: ignored knob reported as mismatch, not trusted", j.applied);
    MODE = "ok";
    r = await jpost("/api/slice", { file: "cube.3mf", settings: { layer_height: 99 } });
    ok(r.status === 400, "settings: out-of-range rejected", r.status);
    r = await jpost("/api/slice", { file: "cube.3mf", settings: { rm_rf: "x" } });
    ok(r.status === 400, "settings: unknown key rejected (no flag injection)", r.status);

    // -- UI-settable config (v2.12b) --
    const src2 = path.join(tmp, "3mf-alt"); fs.mkdirSync(src2);
    fs.copyFileSync(CUBE, path.join(src2, "only.3mf"));
    r = await jpost("/api/slice/config", { srcFolder: src2 });
    ok(r.status === 200 && r.body.srcFolderFound === true, "config: srcFolder accepted with found=true", r.body);
    r = await jget("/api/slice/files");
    ok(r.body.files.length === 1 && r.body.files[0].file === "only.3mf",
      "config: library list follows the new folder LIVE (no restart)", r.body.files);
    ok(CFGOBJ.slicer.srcFolder === src2 && SAVED > 0,
      "config: written into cfg + saveConfig called (persistence path exercised)", { s: CFGOBJ.slicer.srcFolder, n: SAVED });
    r = await jpost("/api/slice/config", { srcFolder: "" });
    ok(r.status === 200 && !("srcFolder" in (CFGOBJ.slicer || {})) && r.body.srcFolder.endsWith("3mf"),
      "config: empty string reverts to default", r.body.srcFolder);
    r = await jpost("/api/slice/config", { plate: -3 });
    ok(r.status === 400, "config: bad plate rejected", r.status);
    r = await jpost("/api/slice/config", { srcFolder: src });  // restore for anything after

    // -- clone engine (v2.12 tranche 4), pure, on real bytes --
    const cl = S.cloneInstances(cube, 4);
    const clE = S.zipRead(cl.buffer);
    const clModel = S.zipEntryContent(clE.find(e => e.name === "3D/3dmodel.model")).toString("utf8");
    const clMs = S.zipEntryContent(clE.find(e => e.name === "Metadata/model_settings.config")).toString("utf8");
    const clItems = [...clModel.matchAll(/<item\b[^>]*\/>/g)];
    const clUuids = clItems.map(m => /p:UUID="([^"]*)"/.exec(m[0])[1]);
    const clIds = [...clMs.matchAll(/key="identify_id" value="(\d+)"/g)].map(m => +m[1]);
    ok(clItems.length === 4 && new Set(clUuids).size === 4,
      "clone: 4 build items with unique UUIDs", clItems.length);
    ok([...clMs.matchAll(/<model_instance>/g)].length === 4 &&
       [...clMs.matchAll(/<assemble_item\b/g)].length === 4 &&
       new Set(clIds).size === clIds.length,
      "clone: model_settings mirrored (4 instances + assemble items, unique identify_ids)");
    const cGeoN = S.zipRead(cube).map(e => e.name).find(n => n.startsWith("3D/Objects/"));
    ok(sha(clE.find(e => e.name === cGeoN).raw) === sha(S.zipRead(cube).find(e => e.name === cGeoN).raw),
      "clone: geometry byte-verbatim");
    ok(sha(S.cloneInstances(cube, 1).buffer) === sha(cube), "clone: copies=1 is a byte no-op");

    srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
  report();
})().catch(e => { console.error("STANDALONE ERROR:", e); process.exit(1); });

function report() {
  console.log("\n" + PASS + " passed, " + FAIL + " failed\n");
  process.exit(FAIL ? 1 : 0);
}
