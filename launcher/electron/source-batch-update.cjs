const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const SOURCE_RESTART_EXIT_CODE = 75;

function runUpstreamBatch(repositoryRoot, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (platform !== "win32") {
    return Promise.reject(new Error("UPDATE-UPSTREAM.bat requires Windows"));
  }
  const batch = path.join(repositoryRoot, "UPDATE-UPSTREAM.bat");
  if (!fs.existsSync(batch)) return Promise.reject(new Error(`Upstream updater not found: ${batch}`));
  const psQuote = value => `'${value.replace(/'/g, "''")}'`;
  const script = [
    `$batch = ${psQuote(batch)}`,
    `$root = ${psQuote(repositoryRoot)}`,
    `$args = '/d /s /c ""' + $batch + '" -NoPause"'`,
    "$child = Start-Process -FilePath $env:ComSpec -ArgumentList $args -WorkingDirectory $root -Wait -PassThru",
    "exit $child.ExitCode",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawnProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", data => { errors = (errors + String(data)).slice(-8_192); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`UPDATE-UPSTREAM.bat failed (${signal || `exit code ${code}`}). ${errors.trim() || "Check the updater console for details."}`));
    });
  });
}

module.exports = { runUpstreamBatch, SOURCE_RESTART_EXIT_CODE };
