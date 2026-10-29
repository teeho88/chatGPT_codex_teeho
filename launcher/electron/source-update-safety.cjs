const fs = require("node:fs");
const path = require("node:path");

async function assertGitReady(repositoryRoot, git) {
  const operations = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase or git am"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["sequencer", "cherry-pick or revert sequence"],
    ["BISECT_LOG", "bisect"],
    ["index.lock", "another Git process or a leftover index.lock"],
  ];
  for (const [name, operation] of operations) {
    const filename = path.resolve(repositoryRoot, await git("rev-parse", "--git-path", name));
    if (fs.existsSync(filename)) {
      throw new Error(`Repository has ${operation} in progress (${filename}). Finish or abort it before updating; no files were changed.`);
    }
  }
  if (await git("ls-files", "--unmerged")) {
    throw new Error("Repository has unresolved conflicts. Resolve and commit them before updating.");
  }
}

async function acquireUpdateLock(repositoryRoot, git) {
  const directory = path.resolve(repositoryRoot, await git("rev-parse", "--git-common-dir"));
  const filename = path.join(directory, "teeho-source-update.lock");
  let descriptor;
  try {
    descriptor = fs.openSync(filename, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let previous;
    try {
      previous = fs.readFileSync(filename, "utf8");
    } catch (readError) {
      if (readError.code !== "ENOENT") throw readError;
    }
    let owner = null;
    try { owner = JSON.parse(previous); } catch { owner = null; }
    let stale = false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); }
      catch (processError) { stale = processError.code === "ESRCH"; }
    }
    if (stale) {
      try {
        if (fs.readFileSync(filename, "utf8") === previous) fs.unlinkSync(filename);
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      }
      try { descriptor = fs.openSync(filename, "wx"); }
      catch (retryError) { if (retryError.code !== "EEXIST") throw retryError; }
    }
    if (descriptor === undefined) {
      throw new Error(`Another source update is running, or an interrupted update left ${filename}. Close other updaters and verify no update is running before removing this lock.`);
    }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    fs.closeSync(descriptor);
    fs.unlinkSync(filename);
    throw error;
  }
  return () => {
    fs.closeSync(descriptor);
    fs.unlinkSync(filename);
  };
}

async function assertNoLocalObstructions(repositoryRoot, git, target) {
  const tracked = new Set((await git("ls-files", "-z")).split("\0").filter(Boolean));
  const incoming = (await git("diff", "--no-renames", "--name-only", "--diff-filter=ACMT", "-z", "HEAD", target)).split("\0").filter(Boolean);
  const blocked = new Set();
  for (const filename of incoming) {
    const parts = filename.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      const relative = parts.slice(0, length).join("/");
      let stat;
      try {
        stat = fs.lstatSync(path.join(repositoryRoot, relative));
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
        throw error;
      }
      if (!tracked.has(relative) && (length === parts.length || !stat.isDirectory())) {
        blocked.add(relative);
        break;
      }
      if (!stat.isDirectory()) break;
    }
  }
  if (blocked.size) {
    throw new Error(`Local untracked or ignored paths would be overwritten by merge: ${[...blocked].map(name => JSON.stringify(name)).join(", ")}. Move or save them before updating.`);
  }
}

function gitErrorDetails(error) {
  return [...new Set([error.message, error.stderr, error.stdout].filter(Boolean).map(value => String(value).trim()))].join("\n");
}

async function resolveMergeConflicts(git, resolveConflict) {
  if (!resolveConflict) return;
  const records = (await git("ls-files", "--unmerged", "-z")).split("\0").filter(Boolean);
  const conflicts = new Map();
  for (const record of records) {
    const match = /^\d+ [0-9a-f]+ ([123])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Could not read Git conflict stages; aborting the update.");
    const [, stage, filename] = match;
    if (!conflicts.has(filename)) conflicts.set(filename, new Set());
    conflicts.get(filename).add(stage);
  }
  let index = 0;
  const decisions = [];
  const filenames = [...conflicts.keys()];
  for (const [filename, stages] of conflicts) {
    const diff = await git(
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=5",
      "--src-prefix=local/", "--dst-prefix=upstream/", "HEAD", "MERGE_HEAD", "--", `:(literal)${filename}`,
    );
    const choice = await resolveConflict({
      filename, hasLocal: stages.has("2"), hasUpstream: stages.has("3"),
      index: ++index, total: conflicts.size, filenames, diff,
    });
    if (choice !== "local" && choice !== "upstream") {
      throw new Error("Conflict resolution cancelled; the automatic merge will be aborted and the backup preserved.");
    }
    decisions.push({ filename, choice, exists: stages.has(choice === "local" ? "2" : "3") });
  }
  for (const { filename, choice, exists } of decisions) {
    const literalPath = `:(literal)${filename}`;
    if (exists) {
      await git("checkout", choice === "local" ? "--ours" : "--theirs", "--", literalPath);
      await git("add", "--", literalPath);
    } else {
      await git("rm", "-f", "--ignore-unmatch", "--", literalPath);
    }
  }
}

module.exports = { assertGitReady, acquireUpdateLock, assertNoLocalObstructions, gitErrorDetails, resolveMergeConflicts };
