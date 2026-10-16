const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { runUpdate } = require("../../scripts/update-upstream.cjs");

const silent = { log() {}, error() {} };

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-cli-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream.git");
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const checkout = path.join(root, "checkout");
  git(root, "init", "--bare", "--initial-branch=main", upstream);
  git(root, "init", "--bare", "--initial-branch=master", origin);
  fs.mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  git(seed, "config", "user.name", "Upstream Test");
  git(seed, "config", "user.email", "upstream@example.test");
  fs.writeFileSync(path.join(seed, "package.json"), '{"version":"1.0.0"}\n');
  fs.writeFileSync(path.join(seed, "README.md"), "upstream readme\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "Initial upstream");
  git(seed, "remote", "add", "origin", upstream);
  git(seed, "push", "origin", "main");
  git(root, "clone", "--branch", "main", upstream, checkout);
  git(checkout, "branch", "-m", "master");
  git(checkout, "config", "user.name", "Local Test");
  git(checkout, "config", "user.email", "local@example.test");
  git(checkout, "remote", "rename", "origin", "upstream");
  git(checkout, "remote", "add", "origin", origin);
  git(checkout, "rm", "README.md");
  git(checkout, "commit", "-m", "Keep README removed");
  git(checkout, "push", "origin", "master");
  return { checkout, upstream, origin, seed };
}

test("upstream CLI pushes unpushed local master commits even without upstream changes", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "local.txt"), "local feature\n");
  git(f.checkout, "add", "local.txt");
  git(f.checkout, "commit", "-m", "Local feature");
  const localHead = git(f.checkout, "rev-parse", "HEAD");
  const result = await runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent });
  assert.equal(result.status, "up-to-date");
  assert.equal(git(f.origin, "rev-parse", "master"), localHead);
  assert.equal(git(f.checkout, "ls-files", "README*.md"), "");
  assert.equal(git(f.checkout, "branch", "--list", "backup/pre-upstream-*"), "");
});

test("upstream CLI check mode fetches new commits without merging or pushing", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, "package.json"), '{"version":"1.0.1"}\n');
  git(f.seed, "add", "package.json");
  git(f.seed, "commit", "-m", "New upstream version");
  git(f.seed, "push", "origin", "main");
  const oldHead = git(f.checkout, "rev-parse", "HEAD");
  const result = await runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, checkOnly: true, logger: silent });
  assert.deepEqual(result, { status: "available", version: "1.0.1" });
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(f.origin, "rev-parse", "master"), oldHead);
  assert.equal(git(f.checkout, "branch", "--list", "backup/pre-upstream-*"), "");
});

test("upstream CLI refuses tracked changes before updating or pushing", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "package.json"), '{"version":"2.0.0"}\n');
  await assert.rejects(
    runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }),
    /Commit or stash tracked changes/,
  );
  assert.match(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), /^M package\.json$/);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "master"));
});

test("upstream CLI never force-pushes a diverged origin master", async t => {
  const f = fixture(t);
  const otherCheckout = path.join(path.dirname(f.checkout), "other");
  git(path.dirname(f.checkout), "clone", "--branch", "master", f.origin, otherCheckout);
  git(otherCheckout, "config", "user.name", "Remote Test");
  git(otherCheckout, "config", "user.email", "remote@example.test");
  fs.writeFileSync(path.join(otherCheckout, "remote.txt"), "remote change\n");
  git(otherCheckout, "add", "remote.txt");
  git(otherCheckout, "commit", "-m", "Remote feature");
  git(otherCheckout, "push", "origin", "master");
  const remoteHead = git(f.origin, "rev-parse", "master");
  fs.writeFileSync(path.join(f.checkout, "local.txt"), "local change\n");
  git(f.checkout, "add", "local.txt");
  git(f.checkout, "commit", "-m", "Local feature");
  await assert.rejects(
    runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }),
    /git push origin master:master/,
  );
  assert.equal(git(f.origin, "rev-parse", "master"), remoteHead);
});
