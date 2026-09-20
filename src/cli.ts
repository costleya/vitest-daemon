#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { isAlive, waitForExit, forceStop } from "./process.js";
import { spawn } from "node:child_process";
import { cp, lstat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requestBuffer, requestJson } from "./client.js";
import {
  acquireStartLock,
  canonicalRoot,
  listDiscovery,
  readDiscovery,
  removeDiscovery,
  socketAddress,
  validateName,
  watcherKey,
} from "./discovery.js";
import { runDaemon } from "./daemon.js";
import type { DiscoveryRecord, JsonResponse } from "./types.js";

const VERSION = "0.1.0";
const SKILL_SOURCE = fileURLToPath(
  new URL("../.agents/skills/vitest-daemon", import.meta.url),
);

type ParsedCommand = {
  command: string;
  positionals: string[];
  root: string;
  vitestArguments: string[];
};

function usage(): string {
  return `Usage:
  vitest-daemon install [--force] [--root <path>]
  vitest-daemon start <name> [--root <path>] -- <vitest arguments>
  vitest-daemon status [name] [--root <path>]
  vitest-daemon snapshot <name> [--root <path>]
  vitest-daemon output <name> [--root <path>]
  vitest-daemon stop <name|--all> [--root <path>]
`;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function install(command: ParsedCommand, root: string): Promise<void> {
  const force = command.positionals[0] === "--force";
  if (
    command.positionals.length > (force ? 1 : 0) ||
    command.vitestArguments.length > 0
  ) {
    throw new Error(usage());
  }

  const destination = path.join(root, ".agents", "skills", "vitest-daemon");
  if ((await pathExists(destination)) && !force) {
    throw new Error(
      `Skill already exists at ${destination}. Use --force to overwrite it.`,
    );
  }

  await cp(SKILL_SOURCE, destination, { recursive: true, force: true });
  process.stdout.write(`Installed vitest-daemon skill at ${destination}.\n`);
}

function parseCommand(arguments_: string[]): ParsedCommand {
  const separator = arguments_.indexOf("--");
  const cliArguments =
    separator === -1 ? arguments_ : arguments_.slice(0, separator);
  const vitestArguments =
    separator === -1 ? [] : arguments_.slice(separator + 1);
  const command = cliArguments.shift() ?? "";
  let root = process.cwd();
  const positionals: string[] = [];

  for (let index = 0; index < cliArguments.length; index += 1) {
    const argument = cliArguments[index];
    if (argument === "--root") {
      const value = cliArguments[index + 1];
      if (!value) throw new Error("--root requires a path.");
      root = value;
      index += 1;
    } else if (argument) {
      positionals.push(argument);
    }
  }
  return { command, positionals, root, vitestArguments };
}

function encodeDaemonOptions(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeDaemonOptions(value: string): {
  root: string;
  name: string;
  vitestArguments: string[];
} {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
    root: string;
    name: string;
    vitestArguments: string[];
  };
}

function isOperationalError(
  response: JsonResponse,
): response is { ok: false; error: string } {
  return !response.ok;
}

async function liveRecord(
  root: string,
  name: string,
): Promise<DiscoveryRecord | undefined> {
  const key = watcherKey(root, name);
  const record = await readDiscovery(key);
  if (!record || record.root !== root || record.name !== name) return undefined;
  try {
    const response = await requestJson(record.socket, { command: "status" });
    return response.ok ? record : undefined;
  } catch {
    if (isAlive(record))
      throw new Error(
        `Watcher ${JSON.stringify(name)} has a live process but its control socket is unavailable; use stop to clean it up.`,
      );
    return undefined;
  }
}

async function requireRecord(
  root: string,
  name: string,
): Promise<DiscoveryRecord> {
  const record = await liveRecord(root, name);
  if (!record)
    throw new Error(`Watcher ${JSON.stringify(name)} is not running.`);
  return record;
}

async function start(command: ParsedCommand, root: string): Promise<void> {
  const name = validateName(command.positionals[0] ?? "");
  if (command.positionals.length !== 1) throw new Error(usage());
  const key = watcherKey(root, name);
  const releaseLock = await acquireStartLock(key);
  try {
    if (await liveRecord(root, name)) {
      throw new Error(`Watcher ${JSON.stringify(name)} is already running.`);
    }
    const previous = await readDiscovery(key);
    if (previous && isAlive(previous))
      throw new Error(
        `Watcher ${JSON.stringify(name)} still has a live process; stop it before restarting.`,
      );
    await removeDiscovery(key);
    if (process.platform !== "win32") {
      await rm(socketAddress(key), { force: true });
    }

    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "__daemon",
        encodeDaemonOptions({
          root,
          name,
          token: randomUUID(),
          vitestArguments: command.vitestArguments,
        }),
      ],
      {
        cwd: root,
        detached: true,
        env: process.env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out while starting the watcher daemon."));
      }, 10_000);
      child.once("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          (message as { ready?: unknown }).ready === true
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Watcher daemon exited during startup (${code ?? "signal"}).`,
          ),
        );
      });
    });
    child.unref();
    process.stdout.write(`Started ${name}.\n`);
  } finally {
    await releaseLock();
  }
}

async function status(command: ParsedCommand, root: string): Promise<void> {
  if (command.positionals.length > 1) throw new Error(usage());
  const requestedName = command.positionals[0];
  if (requestedName) {
    const name = validateName(requestedName);
    const record = await requireRecord(root, name);
    const response = await requestJson(record.socket, { command: "status" });
    if (isOperationalError(response)) throw new Error(response.error);
    if (!("status" in response)) throw new Error("Unexpected daemon response.");
    process.stdout.write(`${JSON.stringify({ status: response.status })}\n`);
    return;
  }

  const records = await listDiscovery(root);
  const active = await Promise.all(
    records.map(async (record) => {
      try {
        const response = await requestJson(record.socket, {
          command: "status",
        });
        return response.ok && "status" in response
          ? { name: record.name, status: response.status }
          : undefined;
      } catch {
        if (isAlive(record))
          throw new Error(
            `Watcher ${JSON.stringify(record.name)} has a live process but its control socket is unavailable; use stop to clean it up.`,
          );
        return undefined;
      }
    }),
  );
  const statuses = active.filter((value) => value !== undefined);
  process.stdout.write(`${JSON.stringify(statuses)}\n`);
}

async function snapshot(command: ParsedCommand, root: string): Promise<void> {
  if (command.positionals.length !== 1) throw new Error(usage());
  const name = validateName(command.positionals[0] ?? "");
  const record = await requireRecord(root, name);
  const response = await requestJson(record.socket, { command: "snapshot" });
  if (isOperationalError(response)) throw new Error(response.error);
  if (!("snapshot" in response)) throw new Error("Unexpected daemon response.");
  process.stdout.write(`${JSON.stringify(response.snapshot)}\n`);
}

async function output(command: ParsedCommand, root: string): Promise<void> {
  if (command.positionals.length !== 1) throw new Error(usage());
  const name = validateName(command.positionals[0] ?? "");
  const record = await requireRecord(root, name);
  process.stdout.write(
    await requestBuffer(record.socket, { command: "output" }),
  );
}

async function stopOne(root: string, name: string): Promise<void> {
  const key = watcherKey(root, validateName(name));
  const record = await readDiscovery(key);
  if (!record || record.root !== root || record.name !== name) {
    throw new Error(`Watcher ${JSON.stringify(name)} is not running.`);
  }
  try {
    const response = await requestJson(record.socket, { command: "stop" });
    if (isOperationalError(response)) throw new Error(response.error);
  } catch (error) {
    if (!record.pid) throw error;
    // Timeout shutdown may exit before a response can be sent.
  }
  if (!record.pid)
    throw new Error(
      "Legacy daemon has no PID; cannot verify shutdown. Retry status before restarting.",
    );
  if (!(await waitForExit(record, 1000))) await forceStop(record);
  await removeDiscovery(key);
}

async function stop(command: ParsedCommand, root: string): Promise<void> {
  if (command.positionals.length !== 1) throw new Error(usage());
  const target = command.positionals[0];
  if (target === "--all") {
    const records = await listDiscovery(root);
    const stopped: string[] = [];
    for (const record of records) {
      try {
        await stopOne(root, record.name);
        stopped.push(record.name);
      } catch (error) {
        if (isAlive(record)) throw error;
        // Stale records are ignored.
      }
    }
    process.stdout.write(
      stopped.length === 0
        ? "No active daemons.\n"
        : `Stopped ${stopped.join(", ")}.\n`,
    );
    return;
  }
  if (!target) throw new Error(usage());
  await stopOne(root, target);
  process.stdout.write(`Stopped ${target}.\n`);
}

async function main(): Promise<void> {
  const rawArguments = process.argv.slice(2);
  if (rawArguments[0] === "__daemon") {
    const encoded = rawArguments[1];
    if (!encoded) throw new Error("Missing daemon options.");
    await runDaemon(decodeDaemonOptions(encoded));
    return;
  }
  if (rawArguments[0] === "--help" || rawArguments.length === 0) {
    process.stdout.write(usage());
    return;
  }
  if (rawArguments[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const command = parseCommand(rawArguments);
  const root = await canonicalRoot(command.root);
  if (command.command === "install") await install(command, root);
  else if (command.command === "start") await start(command, root);
  else if (command.command === "status") await status(command, root);
  else if (command.command === "snapshot") await snapshot(command, root);
  else if (command.command === "output") await output(command, root);
  else if (command.command === "stop") await stop(command, root);
  else throw new Error(usage());
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
