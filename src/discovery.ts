import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DiscoveryRecord } from "./types.js";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function canonicalRoot(root: string): Promise<string> {
  return realpath(path.resolve(root));
}

export function validateName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Watcher names must be 1-64 characters using letters, numbers, dot, underscore, or hyphen.",
    );
  }
  return name;
}

function userId(): string {
  return typeof process.getuid === "function"
    ? String(process.getuid())
    : "user";
}

export function runtimeDirectory(): string {
  if (process.platform === "win32") {
    return path.join(tmpdir(), `vitest-daemon-${userId()}`);
  }
  return path.join("/tmp", `vitest-daemon-${userId()}`);
}

export function watcherKey(root: string, name: string): string {
  return createHash("sha256")
    .update(root)
    .update("\0")
    .update(name)
    .digest("hex")
    .slice(0, 32);
}

export function socketAddress(key: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\vitest-daemon-${userId()}-${key}`;
  }
  return path.join(runtimeDirectory(), `${key}.sock`);
}

export function descriptorPath(key: string): string {
  return path.join(runtimeDirectory(), `${key}.json`);
}

export function lockPath(key: string): string {
  return path.join(runtimeDirectory(), `${key}.lock`);
}

export async function ensureRuntimeDirectory(): Promise<void> {
  const directory = runtimeDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

export async function writeDiscovery(
  key: string,
  record: DiscoveryRecord,
): Promise<void> {
  await ensureRuntimeDirectory();
  const destination = descriptorPath(key);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function readDiscovery(
  key: string,
): Promise<DiscoveryRecord | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(descriptorPath(key), "utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as DiscoveryRecord).root === "string" &&
      typeof (value as DiscoveryRecord).name === "string" &&
      typeof (value as DiscoveryRecord).socket === "string"
    ) {
      return value as DiscoveryRecord;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return undefined;
}

export async function listDiscovery(root: string): Promise<DiscoveryRecord[]> {
  await ensureRuntimeDirectory();
  const entries = await readdir(runtimeDirectory(), { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        try {
          const value: unknown = JSON.parse(
            await readFile(path.join(runtimeDirectory(), entry.name), "utf8"),
          );
          if (
            typeof value === "object" &&
            value !== null &&
            (value as DiscoveryRecord).root === root &&
            typeof (value as DiscoveryRecord).name === "string" &&
            typeof (value as DiscoveryRecord).socket === "string"
          ) {
            return value as DiscoveryRecord;
          }
        } catch {
          // Invalid or concurrently removed discovery entries are not active.
        }
        return undefined;
      }),
  );
  return records
    .filter((record): record is DiscoveryRecord => record !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function removeDiscovery(key: string): Promise<void> {
  await rm(descriptorPath(key), { force: true });
  if (process.platform !== "win32") {
    await rm(socketAddress(key), { force: true });
  }
}

export async function acquireStartLock(
  key: string,
): Promise<() => Promise<void>> {
  await ensureRuntimeDirectory();
  let handle;
  try {
    handle = await open(lockPath(key), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another process is already starting this watcher.");
    }
    throw error;
  }
  return async () => {
    await handle.close();
    await rm(lockPath(key), { force: true });
  };
}
