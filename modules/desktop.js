// modules/desktop.js - start a program on the person's desktop (v2.39.1).
//
// Since 2026-09-28 the Hub runs as a Windows service (U1PrintHub). Services
// live in session 0, so a program the Hub spawns - Snapmaker Orca for Open in
// Orca - starts where nobody can see it: the button "stopped working" and
// invisible Orcas piled up. When U1_DESKTOP_LAUNCHER names a script (the
// service's run wrapper sets it to scripts/open-on-desktop.ps1), the program
// is started through it instead. The script points a Task Scheduler task
// with an Interactive logon at the program and runs it, which is Windows'
// own way into the signed-in user's session.
//
// Without the variable (started by hand, the harness, Docker, Linux) it
// spawns directly, exactly as before.
"use strict";
const { spawn, execFile } = require("child_process");

// launchOnDesktop(exe, target, prefix?) -> Promise<{ via }>
// target is one file path; prefix goes in front of the quoted target
// (for explorer.exe it would be "/select,").
function launchOnDesktop(exe, target, prefix) {
  const launcher = process.env.U1_DESKTOP_LAUNCHER;
  if (!launcher || process.platform !== "win32") {
    return new Promise((resolve, reject) => {
      try { spawn(exe, target ? [(prefix || "") + target] : [], { detached: true, stdio: "ignore" }).unref(); resolve({ via: "spawn" }); }
      catch (e) { reject(e); }
    });
  }
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "-Exe", exe];
  if (target) args.push("-Target", target);
  if (prefix) args.push("-Prefix", prefix);
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || "").trim().split(/\r?\n/)[0] || err.message));
      resolve({ via: "desktop task" });
    });
  });
}

module.exports = { launchOnDesktop };
