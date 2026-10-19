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

test("upstream CLI can publish local commits when versions differ but upstream has no new commits", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "package.json"), '{"version":"2.0.0"}\n');
  fs.writeFileSync(path.join(f.checkout, "local.txt"), "local feature\n");
  git(f.checkout, "add", "local.txt", "package.json");
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
  fs.writeFileSync(path.join(f.checkout, "package.json"), '{"version":"2.0.0"}\n');
  fs.writeFileSync(path.join(f.checkout, "local.txt"), "local change\n");
  git(f.checkout, "add", "local.txt", "package.json");
  git(f.checkout, "commit", "-m", "Local feature");
  await assert.rejects(
    runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }),
    /git push origin master:master/,
  );
  assert.equal(git(f.origin, "rev-parse", "master"), remoteHead);
});

test("upstream CLI refuses unfinished Git operations and index locks without touching them", async t => {
  const f = fixture(t);
  const head = git(f.checkout, "rev-parse", "HEAD");
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG", "index.lock"]) {
    const filename = path.join(f.checkout, ".git", name);
    fs.writeFileSync(filename, `${head}\n`);
    try {
      await assert.rejects(runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }), /in progress/);
      assert.equal(fs.readFileSync(filename, "utf8"), `${head}\n`);
    } finally {
      fs.unlinkSync(filename);
    }
  }
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), head);
  assert.equal(git(f.origin, "rev-parse", "master"), head);
});

test("upstream CLI refuses detached HEAD and other branches", async t => {
  const f = fixture(t);
  git(f.checkout, "switch", "-c", "feature");
  await assert.rejects(runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }), /master branch/);
  git(f.checkout, "checkout", "--detach");
  await assert.rejects(runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }), /master branch/);
});

test("upstream CLI protects ignored files with leading spaces through the real Git runner", async t => {
  const f = fixture(t);
  const filename = " local data.txt";
  fs.writeFileSync(path.join(f.seed, "package.json"), '{"version":"1.0.1"}\n');
  fs.writeFileSync(path.join(f.seed, filename), "upstream\n");
  git(f.seed, "add", "--", filename, "package.json");
  git(f.seed, "commit", "-m", "Add path overlapping ignored local data");
  git(f.seed, "push", "origin", "main");
  fs.appendFileSync(path.join(f.checkout, ".git", "info", "exclude"), `\n${filename}\n`);
  fs.writeFileSync(path.join(f.checkout, filename), "valuable local data\n");
  const oldHead = git(f.checkout, "rev-parse", "HEAD");
  await assert.rejects(runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent }), /overwritten by merge/);
  assert.equal(fs.readFileSync(path.join(f.checkout, filename), "utf8"), "valuable local data\n");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
  assert.equal(git(f.origin, "rev-parse", "master"), oldHead);
});

test("upstream CLI skips merge and push for equal versions despite different commits", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.seed, "upstream.txt"), "same version, new commit\n");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "Upstream code without version bump");
  git(f.seed, "push", "origin", "main");
  fs.writeFileSync(path.join(f.checkout, "local.txt"), "local feature\n");
  git(f.checkout, "add", ".");
  git(f.checkout, "commit", "-m", "Unpublished local change");
  const localHead = git(f.checkout, "rev-parse", "HEAD");
  const remoteHead = git(f.origin, "rev-parse", "master");
  const result = await runUpdate({ repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent });
  assert.deepEqual(result, { status: "up-to-date", version: "1.0.0", reason: "same-version" });
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), localHead);
  assert.equal(git(f.origin, "rev-parse", "master"), remoteHead);
  assert.equal(fs.existsSync(path.join(f.checkout, "upstream.txt")), false);
  assert.equal(git(f.checkout, "branch", "--list", "backup/pre-upstream-*"), "");
});

for (const choice of ["commit", "stash", "abort"]) {
  test(`upstream CLI offers ${choice} before comparing versions`, async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.checkout, "package.json"), '{"version":"1.0.0","staged":true}\n');
    git(f.checkout, "add", "package.json");
    const content = '{"version":"1.0.0","staged":true,"unstaged":true}\n';
    fs.writeFileSync(path.join(f.checkout, "package.json"), content);
    fs.writeFileSync(path.join(f.checkout, "staged-new.txt"), "staged addition\n");
    git(f.checkout, "add", "staged-new.txt");
    fs.writeFileSync(path.join(f.checkout, "untracked.txt"), "keep untracked\n");
    const before = git(f.checkout, "status", "--porcelain");
    const staged = git(f.checkout, "diff", "--cached");
    const unstaged = git(f.checkout, "diff");
    const oldHead = git(f.checkout, "rev-parse", "HEAD");
    let prompts = 0;
    const result = await runUpdate({
      repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent,
      resolveWorkingTree: async ({ status }) => {
        prompts += 1;
        assert.match(status, /package.json/);
        return choice;
      },
    });
    assert.equal(prompts, 1);
    assert.equal(result.status, choice === "abort" ? "cancelled" : "up-to-date");
    assert.equal(fs.readFileSync(path.join(f.checkout, "package.json"), "utf8").replace(/\r\n/g, "\n"), content);
    assert.equal(fs.readFileSync(path.join(f.checkout, "untracked.txt"), "utf8"), "keep untracked\n");
    assert.equal(git(f.origin, "rev-parse", "master"), oldHead);
    if (choice === "commit") {
      assert.notEqual(git(f.checkout, "rev-parse", "HEAD"), oldHead);
      assert.equal(git(f.checkout, "status", "--porcelain", "--untracked-files=no"), "");
      assert.equal(git(f.checkout, "ls-files", "untracked.txt"), "");
      assert.equal(git(f.checkout, "ls-files", "staged-new.txt"), "staged-new.txt");
    } else {
      assert.equal(git(f.checkout, "rev-parse", "HEAD"), oldHead);
      assert.equal(git(f.checkout, "status", "--porcelain"), before);
      assert.equal(git(f.checkout, "diff", "--cached"), staged);
      assert.equal(git(f.checkout, "diff"), unstaged);
    }
    if (choice === "stash") assert.match(git(f.checkout, "stash", "list"), /Teeho: work before upstream update/);
    else assert.equal(git(f.checkout, "stash", "list"), "");
    assert.equal(fs.existsSync(path.join(f.checkout, ".git", "teeho-source-update.lock")), false);
  });
}

test("upstream CLI check mode permits dirty work without a commit or stash prompt", async t => {
  const f = fixture(t);
  const content = '{"version":"1.0.0","dirty":true}\n';
  fs.writeFileSync(path.join(f.checkout, "package.json"), content);
  const result = await runUpdate({
    repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent, checkOnly: true,
    resolveWorkingTree: async () => { throw new Error("Must not prompt in check mode"); },
  });
  assert.equal(result.reason, "same-version");
  assert.equal(fs.readFileSync(path.join(f.checkout, "package.json"), "utf8"), content);
  assert.equal(git(f.checkout, "stash", "list"), "");
});

test("upstream CLI restores stashed work when the upstream check fails", async t => {
  const f = fixture(t);
  const content = '{"version":"1.0.0","dirty":true}\n';
  fs.writeFileSync(path.join(f.checkout, "package.json"), content);
  await assert.rejects(runUpdate({
    repositoryRoot: f.checkout, upstreamUrl: `${f.upstream}-unexpected`, logger: silent,
    resolveWorkingTree: async () => "stash",
  }), /unexpected repository/);
  assert.equal(fs.readFileSync(path.join(f.checkout, "package.json"), "utf8").replace(/\r\n/g, "\n"), content);
  assert.match(git(f.checkout, "stash", "list"), /Teeho/);
  assert.equal(fs.existsSync(path.join(f.checkout, ".git", "teeho-source-update.lock")), false);
});

test("upstream CLI preserves its recovery stash if restoration is blocked", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "package.json"), '{"version":"1.0.0","originalWork":true}\n');
  const replacement = '{"version":"1.0.0","newWork":true}\n';
  await assert.rejects(runUpdate({
    repositoryRoot: f.checkout, upstreamUrl: f.upstream,
    resolveWorkingTree: async () => "stash",
    logger: { error() {}, log(message) {
      if (message.includes("skipping merge and push")) fs.writeFileSync(path.join(f.checkout, "package.json"), replacement);
    } },
  }), /Recovery stash [0-9a-f]+ is preserved/);
  assert.equal(fs.readFileSync(path.join(f.checkout, "package.json"), "utf8"), replacement);
  const sha = git(f.checkout, "rev-parse", "refs/stash");
  assert.match(git(f.checkout, "show", `${sha}:package.json`), /originalWork/);
  assert.equal(fs.existsSync(path.join(f.checkout, ".git", "teeho-source-update.lock")), false);
});

test("upstream CLI never restores an unrelated old stash when Git cannot stash a dirty submodule", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.checkout, "package.json"), '{"version":"1.0.0","oldWork":true}\n');
  git(f.checkout, "stash", "push", "-m", "Existing user stash");
  const oldStash = git(f.checkout, "rev-parse", "refs/stash");
  git(f.checkout, "-c", "protocol.file.allow=always", "submodule", "add", f.upstream, "deps/demo");
  git(f.checkout, "commit", "-m", "Add test submodule");
  const filename = path.join(f.checkout, "deps", "demo", "package.json");
  const nestedWork = '{"version":"1.0.0","nestedWork":true}\n';
  fs.writeFileSync(filename, nestedWork);
  await assert.rejects(runUpdate({
    repositoryRoot: f.checkout, upstreamUrl: f.upstream, logger: silent,
    resolveWorkingTree: async () => "stash",
  }), /did not create a new stash/);
  assert.equal(git(f.checkout, "rev-parse", "refs/stash"), oldStash);
  assert.equal(fs.readFileSync(filename, "utf8"), nestedWork);
  assert.doesNotMatch(fs.readFileSync(path.join(f.checkout, "package.json"), "utf8"), /oldWork/);
});
