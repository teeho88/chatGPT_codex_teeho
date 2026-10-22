const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { runUpstreamBatch } = require("../electron/source-batch-update.cjs");

test("Windows source installation opens an interactive batch console and waits for its result", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-batch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "UPDATE-UPSTREAM.bat"), "@echo off\n");
  let command;
  const spawnProcess = (executable, args, options) => {
    command = { executable, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runUpstreamBatch(root, { platform: "win32", spawnProcess });
  assert.equal(command.executable, "powershell.exe");
  assert.deepEqual(command.args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  const script = Buffer.from(command.args[4], "base64").toString("utf16le");
  assert.match(script, /UPDATE-UPSTREAM\.bat/);
  assert.match(script, /-NoPause/);
  assert.match(script, /Start-Process.*-Wait -PassThru/);
  assert.equal(command.options.cwd, root);
  assert.equal(command.options.windowsHide, true);
});

test("failed batch exit is reported and does not claim an update", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-batch-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "UPDATE-UPSTREAM.bat"), "@echo off\n");
  await assert.rejects(runUpstreamBatch(root, { platform: "win32", spawnProcess: () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 1, null));
    return child;
  } }), /exit code 1/);
});

test("Windows batch runner executes a fixture with spaces in its path and propagates its exit code", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source batch test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const batch = path.join(root, "UPDATE-UPSTREAM.bat");
  fs.writeFileSync(batch, '@echo off\r\necho %~1 > "%~dp0result.txt"\r\nexit /b 0\r\n');
  await runUpstreamBatch(root);
  assert.equal(fs.readFileSync(path.join(root, "result.txt"), "utf8").trim(), "-NoPause");
  fs.writeFileSync(batch, "@echo off\r\nexit /b 7\r\n");
  await assert.rejects(runUpstreamBatch(root), /exit code 7/);
});
