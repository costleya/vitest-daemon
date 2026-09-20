import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { DiscoveryRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export function isAlive(record: DiscoveryRecord): boolean {
  if (!Number.isSafeInteger(record.pid) || record.pid! <= 1) return false;
  try {
    process.kill(record.pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function waitForExit(
  record: DiscoveryRecord,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (isAlive(record)) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

export async function forceStop(record: DiscoveryRecord): Promise<void> {
  if (!isAlive(record)) return;
  // Never signal a PID from stale discovery without verifying its command.
  if (!record.identity || process.platform === "win32") {
    throw new Error("Cannot safely verify daemon identity for forced cleanup.");
  }
  const { stdout } = await execFileAsync(
    "ps",
    ["-p", String(record.pid), "-o", "args="],
    { timeout: 2000 },
  );
  if (!stdout.trimEnd().endsWith(` __daemon ${record.identity}`)) {
    throw new Error("Daemon PID identity changed; refusing forced cleanup.");
  }
  try {
    process.kill(record.pid!, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForExit(record, 2000)))
    throw new Error("Daemon is still alive after forced cleanup.");
}
