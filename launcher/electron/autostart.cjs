const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const LINUX_DESKTOP_NAME = "dev.codexwebgpt.launcher.desktop";
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_SOURCE_VALUE = "Codex Web GPT Teeho Source";

function sourceAutostartCommand(script = path.resolve(__dirname, "..", "..", "scripts", "source-autostart.ps1")) {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`;
}

function sourceAutostartRegistry(args, run = spawnSync) {
  const result = run("reg.exe", args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function getWindowsSourceAutostart(run = spawnSync) {
  const result = sourceAutostartRegistry(["query", WINDOWS_RUN_KEY, "/v", WINDOWS_SOURCE_VALUE], run);
  if (result.status === 1) return { supported: true, enabled: false };
  if (result.status !== 0) throw new Error(`Cannot read Windows source autostart: ${result.stderr || result.stdout}`);
  const value = /^\s+.+?\s+REG_SZ\s+(.+)\s*$/mi.exec(result.stdout)?.[1]?.trim();
  return { supported: true, enabled: value === sourceAutostartCommand() };
}

function setWindowsSourceAutostart(enabled, run = spawnSync) {
  if (enabled) {
    const script = path.resolve(__dirname, "..", "..", "scripts", "source-autostart.ps1");
    const batch = path.resolve(__dirname, "..", "..", "START-APP.bat");
    if (!fs.existsSync(script) || !fs.existsSync(batch)) {
      throw new Error("Windows source startup scripts are missing");
    }
  }
  const args = enabled
    ? ["add", WINDOWS_RUN_KEY, "/v", WINDOWS_SOURCE_VALUE, "/t", "REG_SZ", "/d", sourceAutostartCommand(), "/f"]
    : ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_SOURCE_VALUE, "/f"];
  const result = sourceAutostartRegistry(args, run);
  if (result.status !== 0 && !(result.status === 1 && !enabled && !getWindowsSourceAutostart(run).enabled)) {
    throw new Error(`Cannot ${enabled ? "enable" : "disable"} Windows source autostart: ${result.stderr || result.stdout}`);
  }
  return requireAutostartState(getWindowsSourceAutostart(run), enabled);
}

function linuxDesktopPath() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_NAME);
}

function desktopExecArgument(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replace(/["`$\\]/g, "\\$&")}"`;
}

function linuxExecutable(app) {
  const stableLauncher = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE?.trim();
  if (stableLauncher && path.isAbsolute(stableLauncher)) return stableLauncher;
  const appImage = process.env.CODEX_WEB_GPT_APPIMAGE?.trim() || process.env.APPIMAGE?.trim();
  if (appImage && path.isAbsolute(appImage)) return appImage;
  return app.getPath("exe");
}

function linuxDesktopEntry(app, executable = linuxExecutable(app)) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Codex Web GPT Teeho
Comment=Start the Codex Web GPT launcher in the background
Exec=${desktopExecArgument(executable)} --hidden
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function linuxAutostartMatches(app) {
  const target = linuxDesktopPath();
  try {
    return fs.readFileSync(target, "utf8") === linuxDesktopEntry(app);
  } catch {
    return false;
  }
}

function requireAutostartState(result, desired) {
  if (result.supported && result.enabled !== Boolean(desired)) {
    throw new Error(`The operating system did not ${desired ? "enable" : "disable"} launcher autostart`);
  }
  return result;
}

function setAutostart(app, enabled) {
  if (!app.isPackaged) {
    if (process.platform === "win32") return setWindowsSourceAutostart(enabled);
    return { supported: false, enabled: false };
  }
  if (process.platform === "linux") {
    const target = linuxDesktopPath();
    if (enabled) {
      writePrivateFileAtomic(target, linuxDesktopEntry(app));
    } else {
      fs.rmSync(target, { force: true });
    }
    return requireAutostartState({
      supported: true,
      enabled: enabled ? linuxAutostartMatches(app) : false,
    }, enabled);
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: Boolean(enabled),
      args: ["--hidden"],
    });
    return requireAutostartState({
      supported: true,
      enabled: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin === true,
    }, enabled);
  }
  return { supported: false, enabled: false };
}

function getAutostart(app) {
  if (!app.isPackaged) {
    if (process.platform === "win32") return getWindowsSourceAutostart();
    return { supported: false, enabled: false };
  }
  if (process.platform === "linux") {
    return { supported: true, enabled: linuxAutostartMatches(app) };
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return {
      supported: true,
      enabled: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin === true,
    };
  }
  return { supported: false, enabled: false };
}

module.exports = {
  LINUX_DESKTOP_NAME,
  getAutostart,
  linuxAutostartMatches,
  linuxDesktopEntry,
  linuxDesktopPath,
  requireAutostartState,
  setAutostart,
  getWindowsSourceAutostart,
  setWindowsSourceAutostart,
  sourceAutostartCommand,
  WINDOWS_RUN_KEY,
  WINDOWS_SOURCE_VALUE,
};
