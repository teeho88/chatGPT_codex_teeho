const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const UPSTREAM_URL = "https://github.com/miuuyy/codex-chatgpt-web.git";
const PROTECTED_FEATURES = Object.freeze({
  "src/adapters/chatgpt-web/index.ts": ["UserWaitStore", "userWaitStatePath"],
  "src/config.ts": ["userWaitStatePath"],
  "src/adapters/chatgpt-web/browser-worker.ts": [
    "CHATGPT_RESPONSE_DOM_GRACE_MS",
    "CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS",
  ],
  "src/adapters/chatgpt-web/mcp-server.ts": [
    "CHATGPT_WEB_MCP_APPROVAL_PROGRESS_MS",
    "chatGptMcpInvocationTimeout",
    "waitsForUserApproval",
    "startApprovalProgress",
  ],
});

async function defaultRun(executable, args, cwd) {
  const { stdout } = await execFileAsync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: executable === "git" ? 120_000 : 600_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

function isSourceCheckout(repositoryRoot) {
  return fs.existsSync(path.join(repositoryRoot, ".git"));
}

function preserveFeatures(repositoryRoot) {
  const features = [];
  for (const [filename, tokens] of Object.entries(PROTECTED_FEATURES)) {
    const fullPath = path.join(repositoryRoot, filename);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    for (const token of tokens) {
      if (content.includes(token)) features.push({ filename, token });
    }
  }
  return features;
}

function assertFeaturesPreserved(repositoryRoot, features) {
  const missing = features.filter(({ filename, token }) => {
    const fullPath = path.join(repositoryRoot, filename);
    return !fs.existsSync(fullPath) || !fs.readFileSync(fullPath, "utf8").includes(token);
  });
  if (missing.length) {
    throw new Error(`The merge removed protected local behavior: ${missing.map(item => `${item.filename}: ${item.token}`).join(", ")}`);
  }
}

function createSourceUpdateController({
  repositoryRoot,
  publish,
  logger,
  upstreamUrl = UPSTREAM_URL,
  run = defaultRun,
  now = () => new Date(),
}) {
  const git = (...args) => run("git", args, repositoryRoot);
  let state = isSourceCheckout(repositoryRoot) ? { status: "idle" } : { status: "disabled" };
  let checked = false;
  let pending = null;
  let candidate = null;

  const transition = next => {
    state = next;
    publish?.(next);
    return next;
  };

  async function assertRepository() {
    const actualRoot = await git("rev-parse", "--show-toplevel");
    const actualPath = fs.realpathSync.native(actualRoot);
    const requestedPath = fs.realpathSync.native(repositoryRoot);
    if (path.normalize(actualPath).toLowerCase() !== path.normalize(requestedPath).toLowerCase()) {
      throw new Error(`The launcher source directory is not the Git repository root: ${actualPath} != ${requestedPath}`);
    }
    if (await git("branch", "--show-current") !== "master") {
      throw new Error("Source updates require the master branch");
    }
    let remote;
    try {
      remote = await git("remote", "get-url", "upstream");
    } catch {
      await git("remote", "add", "upstream", upstreamUrl);
      remote = upstreamUrl;
    }
    const accepted = [upstreamUrl];
    if (upstreamUrl === UPSTREAM_URL) {
      accepted.push("git@github.com:miuuyy/codex-chatgpt-web.git", "ssh://git@github.com/miuuyy/codex-chatgpt-web.git");
    }
    if (!accepted.includes(remote)) {
      throw new Error(`The upstream remote points to an unexpected repository: ${remote}`);
    }
  }

  async function fetchCandidate() {
    await assertRepository();
    await git("fetch", "upstream", "--prune");
    const commits = Number(await git("rev-list", "--count", "HEAD..upstream/main"));
    if (!Number.isSafeInteger(commits)) throw new Error("Could not determine upstream changes");
    if (commits === 0) return null;
    const sha = await git("rev-parse", "upstream/main");
    const manifest = JSON.parse(await git("show", "upstream/main:package.json"));
    const localManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const version = manifest.version === localManifest.version
      ? `${manifest.version}+${sha.slice(0, 7)}` : manifest.version;
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
      throw new Error("Upstream returned an invalid package version");
    }
    return { sha, version, releaseVersion: manifest.version };
  }

  async function check() {
    if (state.status === "disabled" || pending) return state;
    transition({ status: "checking" });
    try {
      candidate = await fetchCandidate();
      return transition(candidate ? { status: "available", version: candidate.version } : { status: "up-to-date" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("launcher.source_update_check_failed", { message });
      return transition({ status: "error", message });
    }
  }

  async function checkOnce() {
    if (checked) return state;
    checked = true;
    return check();
  }

  async function assertClean() {
    if ((await git("status", "--porcelain", "--untracked-files=no")).length) {
      throw new Error("Commit or stash tracked changes before updating from upstream");
    }
    if ((await git("ls-files", "--", ":(top,glob)README*.md")).length) {
      throw new Error("Local README files must be untracked before an upstream merge");
    }
  }

  async function update() {
    if (state.status !== "available" || !candidate) throw new Error("No source update is available");
    transition({ status: "downloading", version: candidate.version });
    let merging = false;
    let committed = false;
    let backup;
    try {
      await assertRepository();
      await assertClean();
      const latest = await fetchCandidate();
      if (!latest) return transition({ status: "up-to-date" });
      await assertClean();
      const features = preserveFeatures(repositoryRoot);
      const stamp = now().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
      backup = `backup/pre-upstream-${stamp}`;
      for (let suffix = 1; (await git("branch", "--list", backup)).length; suffix += 1) {
        backup = `backup/pre-upstream-${stamp}-${suffix}`;
      }
      await git("branch", backup, "HEAD");
      transition({ status: "installing", version: latest.version });
      merging = true;
      let mergeError;
      try {
        await git("merge", "--no-commit", "--no-ff", latest.sha);
      } catch (error) {
        mergeError = error;
      }
      await git("rm", "-f", "--ignore-unmatch", "--", ":(top,glob)README*.md");
      const unresolved = await git("diff", "--name-only", "--diff-filter=U");
      if (unresolved) throw new Error(`Upstream merge needs manual conflict resolution: ${unresolved}`);
      if (mergeError) {
        try { await git("rev-parse", "-q", "--verify", "MERGE_HEAD"); }
        catch { throw mergeError; }
      }
      if (await git("ls-files", "--", ":(top,glob)README*.md")) {
        throw new Error("Upstream README files remain tracked after merge");
      }
      assertFeaturesPreserved(repositoryRoot, features);
      await git("diff", "--cached", "--check");
      let bun = "bun";
      try {
        await run(bun, ["--version"], repositoryRoot);
      } catch {
        bun = path.join(repositoryRoot, "launcher", "build", "runtime", "runtime", process.platform === "win32" ? "bun.exe" : "bun");
        if (!fs.existsSync(bun)) throw new Error("Bun was not found on PATH or in launcher/build/runtime");
      }
      await run(bun, ["install", "--frozen-lockfile"], repositoryRoot);
      await run(bun, ["run", "typecheck"], repositoryRoot);
      await run(bun, ["test", ...[
        "tests/user-wait-store.test.ts",
        "tests/zero-risk-mcp-lifecycle.test.ts",
        "tests/browser-worker-contract.test.ts",
        "tests/chatgpt-web-harness.test.ts",
      ]], repositoryRoot);
      await git("diff", "--cached", "--check");
      await git("commit", "-m", `Merge upstream v${latest.releaseVersion}`);
      committed = true;
      merging = false;
      await git("merge-base", "--is-ancestor", latest.sha, "HEAD");
      try {
        await git("push", "origin", "master:master");
      } catch (error) {
        transition({ status: "updated", version: latest.version });
        throw new Error(`Source updated and committed locally, but push to origin failed: ${error.message}`);
      }
      logger?.info("launcher.source_update_completed", { version: latest.version, backup });
      candidate = null;
      return transition({ status: "updated", version: latest.version });
    } catch (error) {
      if (merging && !committed) {
        try {
          let mergeStarted = false;
          try {
            await git("rev-parse", "-q", "--verify", "MERGE_HEAD");
            mergeStarted = true;
          } catch {}
          if (mergeStarted) await git("merge", "--abort");
        } catch (abortError) {
          throw new AggregateError([error, abortError], `Update failed and Git could not abort the merge (backup: ${backup})`);
        }
      }
      transition(committed
        ? { status: "updated", version: candidate.version }
        : { status: "available", version: candidate.version });
      logger?.warn("launcher.source_update_failed", { message: error.message, backup });
      throw error;
    }
  }

  async function beginInstall() {
    if (pending) throw new Error("A source update is already running");
    pending = update();
    try { return await pending; }
    finally { pending = null; }
  }

  return {
    sourceMode: true,
    getState: () => state,
    checkOnce,
    beginInstall,
  };
}

module.exports = { createSourceUpdateController, isSourceCheckout };
