const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { assertGitReady, acquireUpdateLock, assertNoLocalObstructions, gitErrorDetails, resolveMergeConflicts } = require("./source-update-safety.cjs");

const execFileAsync = promisify(execFile);
const UPSTREAM_URL = "https://github.com/miuuyy/codex-chatgpt-web.git";
const EXCLUDED_DOCS = [":(top,glob)README*.md", ":(top)CONTRIBUTING.md", ":(top)SECURITY.md", ":(top)TROUBLESHOOTING.md"];
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
  return args.includes("-z") ? stdout : stdout.trim();
}

function isSourceCheckout(repositoryRoot) {
  return fs.existsSync(path.join(repositoryRoot, ".git"));
}

async function preserveLocalDocumentation(repositoryRoot, git) {
  const tracked = new Set((await git("ls-files", "-z")).split("\0").filter(Boolean));
  const filenames = fs.readdirSync(repositoryRoot).filter(filename =>
    (/^README.*\.md$/.test(filename) || ["CONTRIBUTING.md", "SECURITY.md", "TROUBLESHOOTING.md"].includes(filename)) &&
    !tracked.has(filename) && !fs.lstatSync(path.join(repositoryRoot, filename)).isDirectory());
  if (!filenames.length) return () => {};
  const directory = path.resolve(repositoryRoot, await git("rev-parse", "--git-common-dir"));
  const backup = fs.mkdtempSync(path.join(directory, "teeho-local-docs-"));
  const saved = new Set();
  const restore = () => {
    const errors = [];
    for (const filename of saved) {
      const destination = path.join(repositoryRoot, filename);
      try {
        let exists = false;
        try { fs.lstatSync(destination); exists = true; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (exists) throw new Error(`Cannot restore ${filename}: the destination already exists`);
        fs.renameSync(path.join(backup, filename), destination);
        saved.delete(filename);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      throw new AggregateError(errors, `Could not restore local documentation. Saved files remain at ${backup}. ${errors.map(error => error.message).join("; ")}`);
    }
    fs.rmdirSync(backup);
  };
  try {
    for (const filename of filenames) {
      fs.renameSync(path.join(repositoryRoot, filename), path.join(backup, filename));
      saved.add(filename);
    }
  } catch (error) {
    try { restore(); }
    catch (restoreError) { throw new AggregateError([error, restoreError], `${error.message}\n${restoreError.message}`); }
    throw error;
  }
  return restore;
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
  resolveConflict,
  skipSameVersion = false,
  runBatch,
  acquireLock = acquireUpdateLock,
  run = defaultRun,
  now = () => new Date(),
}) {
  const git = (...args) => run("git", args, repositoryRoot);
  let state = isSourceCheckout(repositoryRoot) ? { status: "idle" } : { status: "disabled" };
  let checked = false;
  let pending = null;
  let candidate = null;
  let sameVersion = null;
  const upToDateState = () => sameVersion
    ? { status: "up-to-date", version: sameVersion, reason: "same-version" }
    : { status: "up-to-date" };

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
    sameVersion = null;
    if (skipSameVersion) {
      const local = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
      const upstream = JSON.parse(await git("show", "upstream/main:package.json")).version;
      for (const version of [local, upstream]) {
        if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
          throw new Error("Cannot compare invalid local or upstream package version");
        }
      }
      logger?.info("launcher.source_update_versions", { local, upstream });
      if (local === upstream) {
        sameVersion = local;
        return null;
      }
    }
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
      return transition(candidate ? { status: "available", version: candidate.version } : upToDateState());
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
    await assertGitReady(repositoryRoot, git);
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
    let releaseLock;
    let restoreDocumentation;
    let failure;
    try {
      releaseLock = await acquireLock(repositoryRoot, git);
      await assertRepository();
      await assertClean();
      const latest = await fetchCandidate();
      if (!latest) return transition(upToDateState());
      await assertClean();
      await git("var", "GIT_AUTHOR_IDENT");
      await git("var", "GIT_COMMITTER_IDENT");
      restoreDocumentation = await preserveLocalDocumentation(repositoryRoot, git);
      await assertNoLocalObstructions(repositoryRoot, git, latest.sha);
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
        await git("merge", "--no-commit", "--no-ff", "--no-autostash", "--no-overwrite-ignore", latest.sha);
      } catch (error) {
        mergeError = error;
      }
      try {
        await git("rev-parse", "-q", "--verify", "MERGE_HEAD");
      } catch {
        merging = false;
        if (mergeError) throw new Error(gitErrorDetails(mergeError));
        throw new Error("Git did not start a merge; retry the upstream check.");
      }
      await git("rm", "-f", "--ignore-unmatch", "--", ...EXCLUDED_DOCS);
      await resolveMergeConflicts(git, resolveConflict);
      const unresolved = await git("diff", "--name-only", "--diff-filter=U");
      if (unresolved) throw new Error(`Upstream merge needs manual conflict resolution: ${unresolved}\nThe automatic merge will be aborted. Backup: ${backup}; upstream commit: ${latest.sha}. Resolve these paths in a manual merge before running the updater again.`);
      if (await git("ls-files", "--", ...EXCLUDED_DOCS)) {
        throw new Error("Excluded upstream documentation remains tracked after merge");
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
      await git("diff", "--exit-code");
      await git("commit", "-m", `Merge upstream v${latest.releaseVersion}`);
      committed = true;
      merging = false;
      await git("merge-base", "--is-ancestor", latest.sha, "HEAD");
      try {
        await git("push", "origin", "master:master");
      } catch (error) {
        transition({ status: "updated", version: latest.version });
        throw new Error(`Source updated and committed locally, but push to origin failed: ${gitErrorDetails(error)}\nLocal commits and backup ${backup} are preserved. Fetch origin and reconcile origin/master before retrying if the push was rejected as non-fast-forward.`);
      }
      logger?.info("launcher.source_update_completed", { version: latest.version, backup });
      candidate = null;
      return transition({ status: "updated", version: latest.version });
    } catch (error) {
      if (error?.stdout || error?.stderr) {
        error = new Error(gitErrorDetails(error), { cause: error });
      }
      if (merging && !committed) {
        try {
          let mergeStarted = false;
          try {
            await git("rev-parse", "-q", "--verify", "MERGE_HEAD");
            mergeStarted = true;
          } catch {}
          if (mergeStarted) await git("merge", "--abort");
        } catch (abortError) {
          error = new AggregateError([error, abortError], `Update failed: ${gitErrorDetails(error)}\nGit could not abort the merge: ${gitErrorDetails(abortError)}\nBackup: ${backup}. Preserve the working tree and resolve or abort the merge manually before retrying.`);
        }
      }
      transition(committed
        ? { status: "updated", version: candidate.version }
        : { status: "available", version: candidate.version });
      logger?.warn("launcher.source_update_failed", { message: error.message, backup });
      failure = error;
      throw error;
    } finally {
      try {
        restoreDocumentation?.();
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], `${failure.message}\n${error.message}`);
        throw error;
      } finally {
        releaseLock?.();
      }
    }
  }

  async function beginInstall() {
    if (pending) throw new Error("A source update is already running");
    if (runBatch) {
      if (state.status !== "available" || !candidate) throw new Error("No source update is available");
      const selected = candidate;
      pending = (async () => {
        transition({ status: "installing", version: selected.version });
        try {
          await runBatch(repositoryRoot);
          await git("merge-base", "--is-ancestor", selected.sha, "HEAD");
          candidate = null;
          return transition({ status: "updated", version: selected.version });
        } catch (error) {
          transition({ status: "available", version: selected.version });
          throw error;
        }
      })();
    } else {
      pending = update();
    }
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
