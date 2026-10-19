const readline = require("node:readline");

function createUpdatePrompts({ input = process.stdin, output = process.stdout } = {}) {
  let reader;
  let lines;
  let listedConflicts = false;
  const open = () => {
    if (!reader) {
      reader = readline.createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
      reader.once("SIGINT", () => reader.close());
      lines = reader[Symbol.asyncIterator]();
    }
  };
  const ask = async (question, choices) => {
    open();
    while (true) {
      output.write(question);
      const answer = await lines.next();
      if (answer.done) return "abort";
      const value = answer.value.trim().toLowerCase();
      if (Object.hasOwn(choices, value)) return choices[value];
      output.write("Invalid choice. Try again.\n");
    }
  };
  const resolveConflict = async ({ filename, hasLocal, hasUpstream, index, total, filenames = [filename] }) => {
    open();
    if (!listedConflicts) {
      listedConflicts = true;
      output.write("\nChoose the complete file version for each conflict. Backup is preserved.\n");
      output.write("Local = your branch before merge; upstream = the incoming version.\n");
      for (const [position, name] of filenames.entries()) output.write(`  ${position + 1}. ${JSON.stringify(name)}\n`);
    }
    output.write(`\nConflict ${index}/${total}: ${JSON.stringify(filename)}\n`);
    output.write(`  [L] Local${hasLocal ? "" : " (file deleted on local side)"}\n`);
    output.write(`  [U] Upstream${hasUpstream ? "" : " (file deleted on upstream side)"}\n`);
    output.write("  [A] Abort update and restore the pre-merge state\n");
    return ask("Choose L / U / A (Enter = abort): ", {
      l: "local", local: "local", u: "upstream", upstream: "upstream", a: "abort", abort: "abort", "": "abort",
    });
  };
  const resolveWorkingTree = async ({ status }) => {
    open();
    output.write(`\nTracked/staged changes:\n${status}\n`);
    output.write("  [C] Commit tracked/staged changes before checking upstream\n");
    output.write("  [S] Stash tracked/staged changes; restore them after the update\n");
    output.write("  [A] Abort without changing your work\n");
    output.write("Untracked files stay in place and are not included in commit/stash.\n");
    return ask("Choose C / S / A (Enter = abort): ", {
      c: "commit", commit: "commit", s: "stash", stash: "stash", a: "abort", abort: "abort", "": "abort",
    });
  };
  return { resolveConflict, resolveWorkingTree, close: () => reader?.close() };
}

function createConflictResolver(options) {
  const prompts = createUpdatePrompts(options);
  const resolve = prompts.resolveConflict;
  resolve.close = prompts.close;
  return resolve;
}

module.exports = { createConflictResolver, createUpdatePrompts };
