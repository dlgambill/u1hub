// Read-only: dump the SET_PRINT_FILAMENT_CONFIG commands a printer has seen
// (Moonraker /server/gcode_store). This is how the color command was found
// in the first place - the touchscreen's own commands land here verbatim.
//   node scripts/peek-gcode-store.js <printer name or index>
const cfg = require("../config.json");
const arg = process.argv[2] || "0";
const p = cfg.printers[Number(arg)] || cfg.printers.find(x => x.name === arg);
if (!p) { console.error("no such printer"); process.exit(1); }
const base = String(p.url).replace(/\/+$/, "");
(async () => {
  const r = await fetch(base + "/server/gcode_store?count=300");
  const j = await r.json();
  const items = (j.result && j.result.gcode_store) || [];
  console.log(p.name, base, "-", items.length, "entries in store");
  for (const it of items) {
    const m = String(it.message || "");
    if (/FILAMENT_CONFIG|filament_config|print_task_config/i.test(m))
      console.log(new Date(it.time * 1000).toLocaleTimeString(), it.type, "|", m.slice(0, 400));
  }
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
