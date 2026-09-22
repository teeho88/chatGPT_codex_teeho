import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TurnUserWait } from "../../types";

export interface SuspendedUserWaitRecord {
  version: 1;
  taskId: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  conversationKey?: string;
  wait: TurnUserWait;
  outstandingToolCallIds: string[];
  suspendedAt: number;
}

function assertRecord(value: unknown): asserts value is SuspendedUserWaitRecord {
  const record = value as Partial<SuspendedUserWaitRecord> | undefined;
  if (!record || record.version !== 1 || typeof record.taskId !== "string" || !record.taskId
    || !record.wait || typeof record.wait.waitId !== "string" || typeof record.wait.ownerTurnId !== "string"
    || !["approval", "user_input", "manual_step"].includes(record.wait.kind)
    || !Number.isFinite(record.wait.enteredAt) || !Number.isFinite(record.suspendedAt)
    || !Array.isArray(record.outstandingToolCallIds) || record.outstandingToolCallIds.some(id => typeof id !== "string")) {
    throw new Error("suspended user-wait record is invalid");
  }
}

/** Versioned, secret-free checkpoint storage for a turn paused on an explicit user decision. */
export class UserWaitStore {
  constructor(private readonly directory: string) {}

  private path(taskId: string): string {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(taskId)) throw new Error("suspended user-wait task id is invalid");
    return join(this.directory, `${taskId}.json`);
  }

  async save(record: SuspendedUserWaitRecord): Promise<void> {
    assertRecord(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(record.taskId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }

  async load(taskId: string): Promise<SuspendedUserWaitRecord | undefined> {
    try {
      const record: unknown = JSON.parse(await readFile(this.path(taskId), "utf8"));
      assertRecord(record);
      if (record.taskId !== taskId) throw new Error("suspended user-wait record task id does not match its file");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async remove(taskId: string): Promise<void> {
    await rm(this.path(taskId), { force: true });
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.path("probe")), { recursive: true, mode: 0o700 });
  }
}
