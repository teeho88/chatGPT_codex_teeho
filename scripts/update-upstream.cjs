const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { createSourceUpdateController } = require("../launcher/electron/source-update.cjs");
const { assertGitReady, acquireUpdateLock, gitErrorDetails } = require("../launcher/electron/source-update-safety.cjs");
const { createUpdatePrompts } = require("./upstream-conflict-prompt.cjs");

const defaultRepositoryRoot = path.resolve(__dirname, "..");

function git(repositoryRoot, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function stashHead(repositoryRoot) {
  try { return git(repositoryRoot, "rev-parse", "--verify", "--quiet", "refs/stash"); }
  catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

async function assertReady(repositoryRoot, { allowDirty = false } = {}) {
  const actualRoot = fs.realpathSync.native(git(repositoryRoot, "rev-parse", "--show-toplevel"));
  const expectedRoot = fs.realpathSync.native(repositoryRoot);
  if (path.normalize(actualRoot).toLowerCase() !== path.normalize(expectedRoot).toLowerCase()) {
    throw new Error(`Expected Git repository root ${expectedRoot}, got ${actualRoot}`);
  }
  if (git(repositoryRoot, "branch", "--show-current") !== "master") {
    throw new Error("Run the upstream update from the master branch");
  }
  git(repositoryRoot, "remote", "get-url", "origin");
  await assertGitReady(repositoryRoot, (...args) => git(repositoryRoot, ...args));
  if (!allowDirty && git(repositoryRoot, "status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Commit or stash tracked changes before updating or pushing");
  }
  if (!allowDirty && git(repositoryRoot, "ls-files", "--", ":(top,glob)README*.md")) {
    throw new Error("README*.md must remain untracked; remove them from Git before updating");
  }
}

function verifyOrigin(repositoryRoot) {
  const localHead = git(repositoryRoot, "rev-parse", "HEAD");
  const remoteHead = git(repositoryRoot, "ls-remote", "origin", "refs/heads/master").split(/\s+/)[0];
  if (localHead !== remoteHead) {
    throw new Error(`origin/master does not match local HEAD (${remoteHead || "missing"} != ${localHead})`);
  }
  return localHead;
}

async function runUpdate({
  repositoryRoot = defaultRepositoryRoot,
  upstreamUrl,
  checkOnly = false,
  resolveConflict,
  resolveWorkingTree,
  logger = console,
} = {}) {
  await assertReady(repositoryRoot, { allowDirty: true });
  const releaseLock = await acquireUpdateLock(repositoryRoot, (...args) => git(repositoryRoot, ...args));
  let stash;
  let failure;
  try {
    await assertReady(repositoryRoot, { allowDirty: true });
    const status = git(repositoryRoot, "status", "--porcelain", "--untracked-files=no");
    if (status && !checkOnly) {
      if (!resolveWorkingTree) throw new Error("Commit or stash tracked changes before updating or pushing");
      const choice = await resolveWorkingTree({ status });
      if (choice === "commit") {
        git(repositoryRoot, "var", "GIT_AUTHOR_IDENT");
        git(repositoryRoot, "var", "GIT_COMMITTER_IDENT");
        git(repositoryRoot, "add", "--update", "--", ".");
        git(repositoryRoot, "commit", "-m", "Save local changes before upstream update");
        logger.log("Tracked/staged changes committed locally.");
      } else if (choice === "stash") {
        const previousStash = stashHead(repositoryRoot);
        git(repositoryRoot, "stash", "push", "-m", `Teeho: work before upstream update ${randomUUID()}`);
        const savedStash = stashHead(repositoryRoot);
        if (!savedStash || savedStash === previousStash) {
          throw new Error("Git did not create a new stash. Handle dirty submodules separately before updating; existing stashes were left untouched.");
        }
        stash = savedStash;
        logger.log(`Tracked/staged changes saved in stash ${stash}; they will be restored after the update.`);
      } else {
        logger.log("Update cancelled; working files and commits were left unchanged.");
        return { status: "cancelled" };
      }
      await assertReady(repositoryRoot);
    }
    const controller = createSourceUpdateController({
      repositoryRoot,
      resolveConflict,
      skipSameVersion: true,
      acquireLock: async () => () => {},
      ...(upstreamUrl ? { upstreamUrl } : {}),
      logger: {
        info: (event, details) => logger.log(`${event}: ${JSON.stringify(details)}`),
        warn: (event, details) => logger.error(`${event}: ${JSON.stringify(details)}`),
      },
      publish: state => logger.log(`Update: ${state.status}${state.version ? ` (${state.version})` : ""}`),
    });
    const state = await controller.checkOnce();
    if (state.status === "error") throw new Error(state.message);
    if (checkOnly) {
      logger.log("Check complete; no working-tree changes, merge, commit, or push performed.");
      return state;
    }
    let result = state;
    if (state.status === "available") result = await controller.beginInstall();
    if (result.reason === "same-version") {
      logger.log(`Local and upstream versions are both ${result.version}; skipping merge and push.`);
      return result;
    }
    if (result.status === "up-to-date") {
      logger.log("No new upstream commits; publishing any local master commits.");
      try { git(repositoryRoot, "push", "origin", "master:master"); }
      catch (error) {
        throw new Error(`Publish failed; local commits are preserved. Fetch origin and reconcile origin/master if histories diverged.\n${gitErrorDetails(error)}`);
      }
    }
    const head = verifyOrigin(repositoryRoot);
    logger.log(`Published origin/master at ${head}`);
    logger.log(git(repositoryRoot, "status", "--short", "--branch"));
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      if (stash) {
        try {
          await assertGitReady(repositoryRoot, (...args) => git(repositoryRoot, ...args));
          git(repositoryRoot, "stash", "apply", "--index", stash);
          logger.log(`Local work and staging restored. Recovery stash retained: ${stash}`);
        } catch (error) {
          const message = `Could not restore local work automatically. Recovery stash ${stash} is preserved; inspect git status before applying it manually.\n${gitErrorDetails(error)}`;
          throw new Error(failure ? `${gitErrorDetails(failure)}\n${message}` : message);
        }
      }
    } finally { releaseLock(); }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node scripts/update-upstream.cjs [--check]");
    process.exitCode = 2;
  } else {
    const prompts = createUpdatePrompts();
    runUpdate({ checkOnly: args.includes("--check"), resolveConflict: prompts.resolveConflict, resolveWorkingTree: prompts.resolveWorkingTree }).catch(error => {
      console.error(`Upstream update failed: ${error.message}`);
      process.exitCode = 1;
    }).finally(() => prompts.close());
  }
}

module.exports = { runUpdate };
