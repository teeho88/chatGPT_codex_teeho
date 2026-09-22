import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserWaitStore } from "../src/adapters/chatgpt-web/user-wait-store";

test("user-wait store round-trips a versioned secret-free checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cgw-user-wait-"));
  try {
    const store = new UserWaitStore(root);
    const record = {
      version: 1 as const, taskId: "task_1", nativeThreadId: "thread_1", nativeTurnId: "turn_1",
      wait: { waitId: "wait_1", kind: "user_input" as const, enteredAt: 1_000, ownerTurnId: "turn_1" },
      outstandingToolCallIds: ["call_1"], suspendedAt: 2_000,
    };
    await store.save(record);
    expect(await store.load("task_1")).toEqual(record);
    await store.remove("task_1");
    expect(await store.load("task_1")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
