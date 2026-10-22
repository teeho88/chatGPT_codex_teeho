const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  getWindowsSourceAutostart,
  setWindowsSourceAutostart,
  sourceAutostartCommand,
  WINDOWS_SOURCE_VALUE,
  WINDOWS_RUN_KEY,
} = require("../electron/autostart.cjs");

test("source autostart owns an independent Windows Run entry and verifies changes", () => {
  let command = null;
  const calls = [];
  const run = (file, args, options) => {
    assert.equal(file, "reg.exe");
    assert.equal(options.windowsHide, true);
    assert.equal(args[1], WINDOWS_RUN_KEY);
    assert.equal(args[3], WINDOWS_SOURCE_VALUE);
    calls.push(args);
    if (args[0] === "add") {
      command = args[args.indexOf("/d") + 1];
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "delete") {
      command = null;
      return { status: 0, stdout: "", stderr: "" };
    }
    return command === null
      ? { status: 1, stdout: "", stderr: "" }
      : { status: 0, stdout: `\r\n    ${WINDOWS_SOURCE_VALUE}    REG_SZ    ${command}\r\n`, stderr: "" };
  };
  assert.deepEqual(getWindowsSourceAutostart(run), { supported: true, enabled: false });
  assert.deepEqual(setWindowsSourceAutostart(true, run), { supported: true, enabled: true });
  assert.equal(command, sourceAutostartCommand());
  assert.match(command, /powershell\.exe .* -WindowStyle Hidden -File "[^"]*source-autostart\.ps1"$/);
  assert.deepEqual(setWindowsSourceAutostart(false, run), { supported: true, enabled: false });
  assert.deepEqual(getWindowsSourceAutostart(run), { supported: true, enabled: false });
  assert.deepEqual(calls.filter(args => args[0] !== "query").map(args => args[0]), ["add", "delete"]);
});

test("source autostart detects a stale checkout path and refuses a false enabled result", () => {
  const run = (_file, args) => args[0] === "query"
    ? { status: 0, stdout: `    ${WINDOWS_SOURCE_VALUE}    REG_SZ    powershell.exe -File "C:\\old\\source-autostart.ps1"`, stderr: "" }
    : { status: 0, stdout: "", stderr: "" };
  assert.deepEqual(getWindowsSourceAutostart(run), { supported: true, enabled: false });
  assert.throws(() => setWindowsSourceAutostart(true, run), /did not enable launcher autostart/);
});

test("Windows source autostart calls START-APP.bat with --hidden", { skip: process.platform !== "win32" }, async t => {
  if (process.platform !== "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-autostart-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  const marker = path.join(root, "arguments.txt");
  fs.copyFileSync(path.join(__dirname, "..", "..", "scripts", "source-autostart.ps1"), path.join(scripts, "source-autostart.ps1"));
  fs.writeFileSync(path.join(root, "START-APP.bat"), `@echo off\r\necho %1>"${marker}"\r\n`);
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "source-autostart.ps1")], { windowsHide: true });
  for (let i = 0; i < 40 && !fs.existsSync(marker); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(fs.readFileSync(marker, "utf8").trim(), "--hidden");
});

test("source launcher forwards hidden startup to Electron and acknowledges a hidden ready window", () => {
  const root = path.resolve(__dirname, "..", "..");
  const batch = fs.readFileSync(path.join(root, "START-APP.bat"), "utf8");
  const ps = fs.readFileSync(path.join(root, "scripts", "start-app.ps1"), "utf8");
  const ts = fs.readFileSync(path.join(root, "scripts", "start-launcher.ts"), "utf8");
  const dev = fs.readFileSync(path.join(root, "launcher", "scripts", "dev.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "launcher", "electron", "main.cjs"), "utf8");
  assert.match(batch, /"--hidden"/);
  assert.match(batch, /APP_HIDDEN_ARG=-Hidden/);
  assert.match(ps, /if \(\$Hidden\) \{ \$launchArgs \+= '--hidden' \}/);
  assert.match(ts, /process\.argv\.includes\("--hidden"\)/);
  assert.match(dev, /\.\.\.\(hidden \? \["--hidden"\] : \[\]\)/);
  assert.match(main, /window\.once\("ready-to-show", \(\) => \{\s*if \(!app\.isPackaged && process\.env\.CODEX_WEB_GPT_UI_READY_FILE\)/);
});
