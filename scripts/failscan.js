const fs = require("fs");
const L = fs.readFileSync(process.argv[2] || "X:/u1-print-hub/scripts/hout.txt", "utf8").split(/\r?\n/);
L.forEach((l, i) => {
  if (l.indexOf("\u2717") !== -1 || /\bfailed\b|not ok|AssertionError|Expected|expected /.test(l)) {
    // print the failing line plus the 3 lines after (usually the assertion detail)
    console.log("L" + (i + 1) + ": " + l);
    for (let k = 1; k <= 4; k++) if (L[i + k] !== undefined) console.log("   " + L[i + k]);
    console.log("----");
  }
});
