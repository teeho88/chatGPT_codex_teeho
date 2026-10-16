const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createSourceUpdateController } = require("../launcher/electron/source-update.cjs");

const defaultRepositoryRoot = path.resolve(__dirname, "..");

function git(repositoryRoot, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  }).trim();
}

function assertReady(repositoryRoot) {
  const actualRoot = fs.realpathSync.native(git(repositoryRoot, "rev-parse", "--show-toplevel"));
  const expectedRoot = fs.realpathSync.native(repositoryRoot);
  if (path.normalize(actualRoot).toLowerCase() !== path.normalize(expectedRoot).toLowerCase()) {
    throw new Error(`Expected Git repository root ${expectedRoot}, got ${actualRoot}`);
  }
  if (git(repositoryRoot, "branch", "--show-current") !== "master") {
    throw new Error("Run the upstream update from the master branch");
  }
  git(repositoryRoot, "remote", "get-url", "origin");
  if (git(repositoryRoot, "status", "--porcelain", "--untracked-files=no")) {
    throw new Error("Commit or stash tracked changes before updating or pushing");
  }
  if (git(repositoryRoot, "ls-files", "--", ":(top,glob)README*.md")) {
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
  logger = console,
} = {}) {
  assertReady(repositoryRoot);
  const controller = createSourceUpdateController({
    repositoryRoot,
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
    logger.log("Check complete; no merge, commit, or push performed.");
    return state;
  }

  let result = state;
  if (state.status === "available") result = await controller.beginInstall();
  if (result.status === "up-to-date") {
    logger.log("No new upstream commits; publishing any local master commits.");
    git(repositoryRoot, "push", "origin", "master:master");
  }

  const head = verifyOrigin(repositoryRoot);
  logger.log(`Published origin/master at ${head}`);
  logger.log(git(repositoryRoot, "status", "--short", "--branch"));
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node scripts/update-upstream.cjs [--check]");
    process.exitCode = 2;
  } else {
    runUpdate({ checkOnly: args.includes("--check") }).catch(error => {
      console.error(`Upstream update failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

module.exports = { runUpdate };
