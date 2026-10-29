const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { Readable, PassThrough } = require("node:stream");
const { resolveMergeConflicts } = require("../electron/source-update-safety.cjs");
const { createConflictResolver, createUpdatePrompts } = require("../../scripts/upstream-conflict-prompt.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-choice-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const output = execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return args.includes("-z") ? output : output.trim();
  };
  const write = (filename, content) => fs.writeFileSync(path.join(root, filename), content);
  git("init", "--initial-branch=master");
  git("config", "user.name", "Conflict Test");
  git("config", "user.email", "conflict@example.test");
  for (const name of ["text.txt", "delete-local.txt", "delete-upstream.txt", "rename.txt", "[literal].txt", " leading space.txt"]) write(name, "base\n");
  write("rename.txt", "unique content for rename detection\n");
  write("literal.txt", "untouched\n");
  write("binary.dat", Buffer.from([0, 1]));
  git("add", ".");
  git("commit", "-m", "Base");
  git("branch", "upstream");
  for (const side of ["local", "upstream"]) {
    if (side === "upstream") git("switch", "upstream");
    for (const name of ["text.txt", "added.txt", "[literal].txt", " leading space.txt"]) write(name, `${side}\n`);
    write("binary.dat", Buffer.from([0, side === "local" ? 2 : 3]));
    git("rm", `delete-${side}.txt`);
    write(`delete-${side === "local" ? "upstream" : "local"}.txt`, `${side}\n`);
    git("mv", "rename.txt", `${side}-name.txt`);
    git("add", "-A");
    git("commit", "-m", side);
  }
  git("switch", "master");
  assert.throws(() => git("merge", "--no-commit", "--no-ff", "upstream"));
  return { root, git };
}

for (const side of ["local", "upstream"]) {
  test(`conflict choices keep ${side} text, binary, additions, deletions and renames`, async t => {
    const { root, git } = fixture(t);
    const prompts = [];
    await resolveMergeConflicts(git, async conflict => {
      prompts.push(conflict);
      return side;
    });
    assert.equal(git("ls-files", "--unmerged"), "");
    for (const name of ["text.txt", "added.txt", "[literal].txt", " leading space.txt"]) {
      assert.equal(fs.readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n"), `${side}\n`);
    }
    assert.deepEqual(fs.readFileSync(path.join(root, "binary.dat")), Buffer.from([0, side === "local" ? 2 : 3]));
    assert.equal(fs.existsSync(path.join(root, `delete-${side}.txt`)), false);
    assert.equal(fs.existsSync(path.join(root, `${side}-name.txt`)), true);
    const other = side === "local" ? "upstream" : "local";
    assert.equal(fs.existsSync(path.join(root, `${other}-name.txt`)), false);
    assert.equal(fs.readFileSync(path.join(root, "literal.txt"), "utf8").trim(), "untouched");
    assert.equal(prompts.find(item => item.filename === "delete-local.txt").hasLocal, false);
    assert.equal(prompts.find(item => item.filename === "delete-upstream.txt").hasUpstream, false);
    const textDiff = prompts.find(item => item.filename === "text.txt").diff;
    assert.match(textDiff, /--- local\/text\.txt/);
    assert.match(textDiff, /\+\+\+ upstream\/text\.txt/);
    assert.match(textDiff, /\n-local\r?\n/);
    assert.match(textDiff, /\n\+upstream(?:\r?\n|$)/);
    assert.match(prompts.find(item => item.filename === "binary.dat").diff, /Binary files .* differ/);
    assert.match(prompts.find(item => item.filename === "delete-local.txt").diff, /new file mode/);
    assert.match(prompts.find(item => item.filename === "delete-upstream.txt").diff, /deleted file mode/);
    assert.match(prompts.find(item => item.filename === "[literal].txt").diff, /\n-local\r?\n/);
    assert.equal(prompts.at(-1).index, prompts.length);
    assert.ok(prompts.every(item => item.total === prompts.length));
  });
}

test("cancelling after a choice leaves all conflict stages untouched until the caller aborts", async t => {
  const { git } = fixture(t);
  const original = git("ls-files", "--unmerged", "-z");
  let calls = 0;
  await assert.rejects(resolveMergeConflicts(git, async () => ++calls === 1 ? "local" : "abort"), /cancelled/);
  assert.equal(git("ls-files", "--unmerged", "-z"), original);
  git("merge", "--abort");
  assert.equal(git("status", "--porcelain"), "");
});

test("conflict choices can mix local and upstream across files", async t => {
  const { root, git } = fixture(t);
  await resolveMergeConflicts(git, async ({ filename }) => filename === "added.txt" ? "upstream" : "local");
  assert.equal(git("ls-files", "--unmerged"), "");
  assert.equal(fs.readFileSync(path.join(root, "text.txt"), "utf8").trim(), "local");
  assert.equal(fs.readFileSync(path.join(root, "added.txt"), "utf8").trim(), "upstream");
});

test("conflict prompt accepts per-file choices and retries invalid input", async () => {
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk; });
  const resolve = createConflictResolver({ input: Readable.from(["wrong\nL\nupstream\n"]), output });
  try {
    assert.equal(await resolve({ filename: "one.txt", hasLocal: true, hasUpstream: false, index: 1, total: 2 }), "local");
    assert.equal(await resolve({ filename: "two.txt", hasLocal: false, hasUpstream: true, index: 2, total: 2 }), "upstream");
    assert.match(transcript, /Invalid choice/);
    assert.match(transcript, /file deleted on upstream side/);
    assert.match(transcript, /file deleted on local side/);
  } finally { resolve.close(); }
});

test("conflict prompt shows code differences before offering the file choices", async t => {
  const { git } = fixture(t);
  const output = new PassThrough();
  let transcript = "";
  output.on("data", chunk => { transcript += chunk; });
  const resolve = createConflictResolver({ input: Readable.from(["a\n"]), output });
  try {
    await assert.rejects(resolveMergeConflicts(git, resolve), /cancelled/);
    assert.match(transcript, /Code comparison: - Local \/ \+ Upstream/);
    assert.match(transcript, /\n-local\r?\n/);
    assert.match(transcript, /\n\+upstream\r?\n/);
    assert.ok(transcript.indexOf("Code comparison:") < transcript.indexOf("  [L] Local"));
    assert.ok(transcript.indexOf("+upstream") < transcript.indexOf("Choose L / U / A"));
    assert.notEqual(git("ls-files", "--unmerged"), "");
  } finally { resolve.close(); }
});

for (const answer of ["\n", "a\n", ""]) {
  test(`conflict prompt aborts safely for ${JSON.stringify(answer)}`, async () => {
    const resolve = createConflictResolver({ input: Readable.from([answer]), output: new PassThrough() });
    try {
      assert.equal(await resolve({ filename: "one.txt", hasLocal: true, hasUpstream: true, index: 1, total: 1 }), "abort");
    } finally { resolve.close(); }
  });
}

test("working-tree menu and conflict menu share queued input", async () => {
  const prompts = createUpdatePrompts({ input: Readable.from(["bad\ns\nu\n"]), output: new PassThrough() });
  try {
    assert.equal(await prompts.resolveWorkingTree({ status: " M package.json" }), "stash");
    assert.equal(await prompts.resolveConflict({ filename: "code.ts", hasLocal: true, hasUpstream: true, index: 1, total: 1 }), "upstream");
  } finally { prompts.close(); }
});

for (const [answer, expected] of [["C\n", "commit"], ["\n", "abort"], ["", "abort"]]) {
  test(`working-tree menu handles ${JSON.stringify(answer)}`, async () => {
    const prompts = createUpdatePrompts({ input: Readable.from([answer]), output: new PassThrough() });
    try {
      assert.equal(await prompts.resolveWorkingTree({ status: " M package.json" }), expected);
    } finally { prompts.close(); }
  });
}
