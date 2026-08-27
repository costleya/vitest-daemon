import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalRoot,
  socketAddress,
  validateName,
  watcherKey,
} from "../src/discovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("discovery identity", () => {
  it("canonicalizes the worktree before deriving watcher identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vitest-daemon-root-"));
    temporaryDirectories.push(directory);

    const canonical = await canonicalRoot(directory);
    expect(canonical).toBe(await realpath(directory));
    expect(watcherKey(canonical, "unit")).toHaveLength(32);
    expect(socketAddress(watcherKey(canonical, "unit"))).toContain(
      watcherKey(canonical, "unit"),
    );
  });

  it("accepts shell-safe names and rejects ambiguous names", () => {
    expect(validateName("unit.nuxt-1")).toBe("unit.nuxt-1");
    expect(() => validateName("unit tests")).toThrow(/Watcher names/);
    expect(() => validateName("../unit")).toThrow(/Watcher names/);
    expect(() => validateName("")).toThrow(/Watcher names/);
  });
});
