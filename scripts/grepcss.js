const fs = require("fs"), path = require("path");
const root = process.argv[2];
const re = new RegExp(process.argv[3] || "dsp-");
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); }
    else if (/\.(css|html|js)$/.test(e.name)) {
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
      lines.forEach((l, i) => { if (re.test(l)) console.log(p + ":" + (i + 1) + ": " + l.trim().slice(0, 120)); });
    }
  }
}
function grepFile(p) {
  const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  lines.forEach((l, i) => { if (re.test(l)) console.log(p + ":" + (i + 1) + ": " + l.trim().slice(0, 130)); });
}
fs.statSync(root).isDirectory() ? walk(root) : grepFile(root);
