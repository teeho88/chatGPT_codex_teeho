const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { createSourceUpdateController, isSourceCheckout } = require("../electron/source-update.cjs");

const execAsync = promisify(execFile);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function write(root, filename, content) {
  fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
  fs.writeFileSync(path.join(root, filename), content);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-updater-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream.git");
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  git(root, "init", "--bare", "--initial-branch=main", upstream);
  git(root, "init", "--bare", "--initial-branch=master", origin);
  fs.mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  git(seed, "config", "user.name", "Updater Test");
  git(seed, "config", "user.email", "updater@example.test");
  write(seed, "package.json", JSON.stringify({ version: "1.0.0" }));
  write(seed, "README.md", "upstream readme\n");
  for (const filename of ["CONTRIBUTING.md", "SECURITY.md", "TROUBLESHOOTING.md"]) {
    write(seed, filename, "initial upstream documentation\n");
  }
  write(seed, "feature.txt", "initial\n");
  write(seed, "src/adapters/chatgpt-web/index.ts", "UserWaitStore userWaitStatePath\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Initial");
  git(seed, "remote", "add", "origin", upstream);
  git(seed, "push", "origin", "main");
  git(root, "clone", "--branch", "main", upstream, checkout);
  git(checkout, "branch", "-m", "master");
  git(checkout, "config", "user.name", "Updater Test");
  git(checkout, "config", "user.email", "updater@example.test");
  git(checkout, "remote", "rename", "origin", "upstream");
  git(checkout, "remote", "add", "origin", origin);
  git(checkout, "rm", "README.md", "CONTRIBUTING.md", "SECURITY.md", "TROUBLESHOOTING.md");
  git(checkout, "commit", "-m", "Preserve local README removal");
  git(checkout, "push", "origin", "master");

  const publishUpstream = ({ feature = "initial\n", version = "1.0.1" } = {}) => {
    write(seed, "package.json", JSON.stringify({ version }));
    write(seed, "README.md", "updated upstream readme\n");
    for (const filename of ["CONTRIBUTING.md", "SECURITY.md", "TROUBLESHOOTING.md"]) {
      write(seed, filename, "updated upstream documentation\n");
    }
    write(seed, "feature.txt", feature);
    git(seed, "add", ".");
    git(seed, "commit", "-m", "Upstream update");
    git(seed, "push", "origin", "main");
    return git(seed, "rev-parse", "HEAD");
  };

  const bunCalls = [];
  const run = async (executable, args, cwd) => {
    if (executable !== "git") {
      bunCalls.push(args);
      return args[0] === "--version" ? "1.4.0" : "";
    }
    const { stdout } = await execAsync(executable, args, { cwd, encoding: "utf8", windowsHide: true });
    return stdout.trim();
  };
  const controller = () => createSourceUpdateController({ repositoryRoot: checkout, upstreamUrl: upstream, run });
  return { checkout, upstream, origin, publishUpstream, bunCalls, run, controller };
}

test("source update fetches, creates backup, resolves README deletion, tests, commits and pushes", async t => {
  const f = fixture(t);
  assert.equal(isSourceCheckout(f.checkout), true);
  const upstreamCommit = f.publishUpstream();
  const controller = f.controller();
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.0.1" });
  assert.deepEqual(await controller.beginInstall(), { status: "updated", version: "1.0.1" });
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "master"));
  assert.equal(git(f.checkout, "merge-base", "--is-ancestor", upstreamCommit, "HEAD"), "");
  assert.equal(git(f.checkout, "ls-files", "README*.md"), "");
  assert.equal(git(f.checkout, "ls-files", "CONTRIBUTING.md", "SECURITY.md", "TROUBLESHOOTING.md"), "");
  assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), "");
  assert.match(git(f.checkout, "branch", "--list", "backup/pre-upstream-*"), /pre-upstream-/);
  assert.deepEqual(f.bunCalls.map(args => args.slice(0, 2)), [
    ["--version"], ["install", "--frozen-lockfile"], ["run", "typecheck"], ["test", "tests/user-wait-store.test.ts"],
  ]);
  assert.equal(await controller.checkOnce().then(state => state.status), "updated");
});

test("source updater refuses dirty tracked files without touching them", async t => {
  const f = fixture(t);
  f.publishUpstream();
  const controller = f.controller();
  assert.equal((await controller.checkOnce()).status, "available");
  write(f.checkout, "feature.txt", "my work\n");
  await assert.rejects(controller.beginInstall(), /Commit or stash tracked changes/);
  assert.equal(fs.readFileSync(path.join(f.checkout, "feature.txt"), "utf8"), "my work\n");
  assert.equal(git(f.checkout, "branch", "--list", "backup/pre-upstream-*"), "");
});

test("source updater aborts non-README conflicts and keeps recovery branch", async t => {
  const f = fixture(t);
  write(f.checkout, "feature.txt", "my local feature\n");
  git(f.checkout, "add", "feature.txt");
  git(f.checkout, "commit", "-m", "Local feature");
  const oldHead = git(f.checkout, "rev-parse", "HEAD");
  f.publishUpstream({ feature: "conflicting upstream feature\n" });
  const controller = f.controller();
  assert.equal((await controller.checkOnce()).status, "available");
  await assert.rejects(controller.beginInstall(), /manual conflict resolution: feature.txt/);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
  assert.equal(fs.readFileSync(path.join(f.checkout, "feature.txt"), "utf8").replace(/\r\n/g, "\n"), "my local feature\n");
  assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), "");
  assert.match(git(f.checkout, "branch", "--list", "backup/pre-upstream-*"), /pre-upstream-/);
});

test("source updater rolls back merge when checks fail", async t => {
  const f = fixture(t);
  f.publishUpstream();
  const oldHead = git(f.checkout, "rev-parse", "HEAD");
  const run = async (executable, args, cwd) => {
    if (executable !== "git" && args[0] === "run" && args[1] === "typecheck") {
      throw new Error("Typecheck failed");
    }
    return f.run(executable, args, cwd);
  };
  const controller = createSourceUpdateController({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, run });
  assert.equal((await controller.checkOnce()).status, "available");
  await assert.rejects(controller.beginInstall(), /Typecheck failed/);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(controller.getState().status, "available");
});

test("source update preserves the original error when Git refuses to start a merge", async t => {
  const f = fixture(t);
  f.publishUpstream();
  const oldHead = git(f.checkout, "rev-parse", "HEAD");
  const run = async (executable, args, cwd) => {
    if (executable === "git" && args[0] === "merge" && args[1] === "--no-commit") {
      throw new Error("Git refused to start merge");
    }
    return f.run(executable, args, cwd);
  };
  const controller = createSourceUpdateController({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, run });
  assert.equal((await controller.checkOnce()).status, "available");
  await assert.rejects(controller.beginInstall(), /Git refused to start merge/);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(controller.getState().status, "available");
});

test("source updater refuses an upstream merge that removes local protected behavior", async t => {
  const f = fixture(t);
  f.publishUpstream();
  const seed = path.join(path.dirname(f.upstream), "seed");
  write(seed, "src/adapters/chatgpt-web/index.ts", "New upstream implementation\n");
  git(seed, "add", "src/adapters/chatgpt-web/index.ts");
  git(seed, "commit", "-m", "Remove old behavior");
  git(seed, "push", "origin", "main");
  const oldHead = git(f.checkout, "rev-parse", "HEAD");
  const controller = f.controller();
  assert.equal((await controller.checkOnce()).status, "available");
  await assert.rejects(controller.beginInstall(), /removed protected local behavior/);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), "");
});

test("source update leaves committed changes in place when origin push fails", async t => {
  const f = fixture(t);
  const upstreamCommit = f.publishUpstream();
  const run = async (executable, args, cwd) => {
    if (executable === "git" && args[0] === "push" && args[1] === "origin") {
      throw new Error("Remote rejected push");
    }
    return f.run(executable, args, cwd);
  };
  const controller = createSourceUpdateController({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, run });
  assert.equal((await controller.checkOnce()).status, "available");
  await assert.rejects(controller.beginInstall(), /updated and committed locally, but push to origin failed/);
  assert.equal(git(f.checkout, "merge-base", "--is-ancestor", upstreamCommit, "HEAD"), "");
  assert.equal(controller.getState().status, "updated");
});
