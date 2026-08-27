import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { requestBuffer } from "../src/client.js";
import {
  canonicalRoot,
  readDiscovery,
  watcherKey,
  writeDiscovery,
} from "../src/discovery.js";
import type { WatchSnapshot } from "../src/types.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const fixtures: string[] = [];

type CommandResult = { stdout: string; stderr: string };

async function command(
  root: string,
  ...arguments_: string[]
): Promise<CommandResult> {
  const [commandName, ...commandArguments] = arguments_;
  return execFileAsync(
    process.execPath,
    [cliPath, commandName ?? "", "--root", root, ...commandArguments],
    {
      encoding: "utf8",
      timeout: 15_000,
    },
  );
}

async function output(root: string, name: string): Promise<Buffer> {
  const result = await execFileAsync(
    process.execPath,
    [cliPath, "output", name, "--root", root],
    { encoding: "buffer", timeout: 15_000 },
  );
  return result.stdout;
}

async function createFixture(label: string): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), `vitest-daemon-${label}-`),
  );
  fixtures.push(directory);
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: `fixture-${label}`, type: "module", private: true }),
  );
  await symlink(
    path.join(repositoryRoot, "node_modules"),
    path.join(directory, "node_modules"),
  );
  await writeFile(
    path.join(directory, "vitest.config.mjs"),
    `export default { test: { reporters: ['verbose'], projects: [{ test: { name: 'unit', include: ['sample.test.mjs'] } }] } }\n`,
  );
  await writePassingTest(directory, `${label}-pass`);
  return directory;
}

async function writePassingTest(root: string, marker: string): Promise<void> {
  await writeFile(
    path.join(root, "sample.test.mjs"),
    `import { expect, test } from 'vitest'\n` +
      `test('sample', async () => {\n` +
      `  await new Promise(resolve => setTimeout(resolve, 250))\n` +
      `  console.log(${JSON.stringify(marker)})\n` +
      `  expect(true).toBe(true)\n` +
      `})\n`,
  );
}

async function writeFailingTest(root: string, marker: string): Promise<void> {
  await writeFile(
    path.join(root, "sample.test.mjs"),
    `import { expect, test } from 'vitest'\n` +
      `test('sample', async () => {\n` +
      `  await new Promise(resolve => setTimeout(resolve, 250))\n` +
      `  console.log(${JSON.stringify(marker)})\n` +
      `  expect(true).toBe(false)\n` +
      `})\n`,
  );
}

async function snapshot(root: string, name: string): Promise<WatchSnapshot> {
  const result = await command(root, "snapshot", name, "--json");
  return JSON.parse(result.stdout) as WatchSnapshot;
}

async function waitForSnapshot(
  root: string,
  name: string,
  state: WatchSnapshot["state"],
): Promise<WatchSnapshot> {
  const deadline = Date.now() + 15_000;
  let current: WatchSnapshot = { state: "checking" };
  while (Date.now() < deadline) {
    current = await snapshot(root, name);
    if (current.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${state}; current snapshot: ${JSON.stringify(current)}`,
  );
}

async function stopAll(root: string): Promise<void> {
  try {
    await command(root, "stop", "--all");
  } catch {
    // A failed test may already have torn down its daemons.
  }
}

async function waitForNoDaemons(root: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const statuses = JSON.parse(
      (await command(root, "status", "--json")).stdout,
    ) as unknown[];
    if (statuses.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for watcher daemons to stop.");
}

beforeAll(async () => {
  await mkdir(path.join(repositoryRoot, "dist"), { recursive: true });
  await readFile(cliPath);
});

afterEach(async () => {
  await Promise.all(fixtures.map(stopAll));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await Promise.all(
    fixtures
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe.sequential("vitest-daemon CLI", () => {
  it("survives the launcher, separates status/snapshot/output, and follows edits", async () => {
    const root = await createFixture("lifecycle");
    await command(
      root,
      "start",
      "unit",
      "--",
      "sample.test.mjs",
      "--project",
      "unit",
    );

    const daemonStatus = JSON.parse(
      (await command(root, "status", "unit", "--json")).stdout,
    ) as Record<string, unknown>;
    expect(Object.keys(daemonStatus)).toEqual(["status"]);
    expect(["starting", "running"]).toContain(daemonStatus.status);

    const passing = await waitForSnapshot(root, "unit", "passed");
    expect(passing).toMatchObject({
      state: "passed",
      counts: { passed: 1, failed: 0, skipped: 0 },
    });

    const canonical = await canonicalRoot(root);
    const record = await readDiscovery(watcherKey(canonical, "unit"));
    expect(record).toBeDefined();
    const directOutput = await requestBuffer(record!.socket, {
      command: "output",
    });
    expect(await output(root, "unit")).toEqual(directOutput);
    expect(directOutput.toString()).toContain("lifecycle-pass");

    await writeFailingTest(root, "lifecycle-fail");
    await waitForSnapshot(root, "unit", "checking");
    expect(await snapshot(root, "unit")).toEqual({ state: "checking" });
    const failing = await waitForSnapshot(root, "unit", "failed");
    expect(failing).toMatchObject({
      state: "failed",
      counts: { passed: 0, failed: 1, skipped: 0 },
    });

    await writePassingTest(root, "lifecycle-recovered");
    const recovered = await waitForSnapshot(root, "unit", "passed");
    expect(recovered).toMatchObject({
      state: "passed",
      counts: { passed: 1, failed: 0, skipped: 0 },
      failures: [],
    });
  });

  it("supports multiple names and isolates identical names across roots", async () => {
    const firstRoot = await createFixture("first");
    const secondRoot = await createFixture("second");

    await command(
      firstRoot,
      "start",
      "shared",
      "--",
      "sample.test.mjs",
      "--project",
      "unit",
    );
    await command(
      firstRoot,
      "start",
      "other",
      "--",
      "sample.test.mjs",
      "--project",
      "unit",
    );
    await command(
      secondRoot,
      "start",
      "shared",
      "--",
      "sample.test.mjs",
      "--project",
      "unit",
    );

    const firstStatuses = JSON.parse(
      (await command(firstRoot, "status", "--json")).stdout,
    ) as Array<{ name: string; status: string }>;
    const secondStatuses = JSON.parse(
      (await command(secondRoot, "status", "--json")).stdout,
    ) as Array<{ name: string; status: string }>;
    expect(firstStatuses.map(({ name }) => name)).toEqual(["other", "shared"]);
    expect(secondStatuses.map(({ name }) => name)).toEqual(["shared"]);

    await command(firstRoot, "stop", "shared");
    expect((await command(firstRoot, "status", "other")).stdout).toMatch(
      /starting|running/,
    );
    expect((await command(secondRoot, "status", "shared")).stdout).toMatch(
      /starting|running/,
    );

    await command(firstRoot, "stop", "--all");
    await waitForNoDaemons(firstRoot);
    expect((await command(firstRoot, "status")).stdout).toBe(
      "No active daemons.\n",
    );
    expect((await command(secondRoot, "status", "shared")).stdout).toMatch(
      /starting|running/,
    );
  });

  it("recovers a stale discovery entry when starting the same watcher name", async () => {
    const root = await createFixture("stale");
    const canonical = await canonicalRoot(root);
    const key = watcherKey(canonical, "unit");
    await writeDiscovery(key, {
      root: canonical,
      name: "unit",
      socket: path.join(root, "missing.sock"),
    });

    await command(
      root,
      "start",
      "unit",
      "--",
      "sample.test.mjs",
      "--project",
      "unit",
    );
    await waitForSnapshot(root, "unit", "passed");
    expect((await command(root, "status", "unit")).stdout).toBe("running\n");
  });
});
