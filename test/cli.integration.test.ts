import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
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
const fixtureNodeModules = path.resolve(
  process.env.VITEST_DAEMON_FIXTURE_NODE_MODULES ??
    path.join(repositoryRoot, "node_modules"),
);
const vitePlusNodeModules = process.env.VITEST_DAEMON_VITE_PLUS_NODE_MODULES;
const fixtures: string[] = [];
// pnpm's Vitest launcher injects NODE_PATH for its own dependencies. Fixture
// processes must resolve their runner from the fixture's installation alone.
const fixtureEnvironment = { ...process.env };
delete fixtureEnvironment.NODE_PATH;

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
      env: fixtureEnvironment,
    },
  );
}

async function output(root: string, name: string): Promise<Buffer> {
  const result = await execFileAsync(
    process.execPath,
    [cliPath, "output", name, "--root", root],
    { encoding: "buffer", timeout: 15_000, env: fixtureEnvironment },
  );
  return result.stdout;
}

async function waitForOutputMarker(
  root: string,
  name: string,
  marker: string,
): Promise<string> {
  const deadline = Date.now() + 15_000;
  let current = "";
  while (Date.now() < deadline) {
    current = (await output(root, name)).toString();
    if (current.includes(marker)) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for output marker ${JSON.stringify(marker)}; current snapshot: ${JSON.stringify(await snapshot(root, name))}; current output: ${current}`,
  );
}

async function createFixture(
  label: string,
  linkNodeModules = true,
): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), `vitest-daemon-${label}-`),
  );
  fixtures.push(directory);
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ name: `fixture-${label}`, type: "module", private: true }),
  );
  if (linkNodeModules) {
    await symlink(fixtureNodeModules, path.join(directory, "node_modules"));
  }
  await writeFile(
    path.join(directory, "vitest.config.mjs"),
    `export default { test: { reporters: ['verbose'], projects: [{ test: { name: 'unit', include: ['sample.test.mjs'] } }] } }\n`,
  );
  await writePassingTest(directory, `${label}-pass`);
  return directory;
}

async function writePassingTest(
  root: string,
  marker: string,
  testImport = "vitest",
): Promise<void> {
  await writeFile(
    path.join(root, "sample.test.mjs"),
    `import { expect, test } from ${JSON.stringify(testImport)}\n` +
      `test('sample', async () => {\n` +
      `  await new Promise(resolve => setTimeout(resolve, 250))\n` +
      `  console.log(${JSON.stringify(marker)})\n` +
      `  console.error(${JSON.stringify(`${marker.toUpperCase()}-STDERR`)})\n` +
      `  expect(true).toBe(true)\n` +
      `})\n`,
  );
}

async function writeFailingTest(
  root: string,
  marker: string,
  testImport = "vitest",
): Promise<void> {
  await writeFile(
    path.join(root, "sample.test.mjs"),
    `import { expect, test } from ${JSON.stringify(testImport)}\n` +
      `test('sample', async () => {\n` +
      `  await new Promise(resolve => setTimeout(resolve, 250))\n` +
      `  console.log(${JSON.stringify(marker)})\n` +
      `  console.error(${JSON.stringify(`${marker.toUpperCase()}-STDERR`)})\n` +
      `  expect(true).toBe(false)\n` +
      `})\n`,
  );
}

async function createResolutionFixture(): Promise<string> {
  const root = await createFixture("resolution", false);
  await mkdir(path.join(root, "node_modules"));
  return root;
}

async function installNodeApi(
  root: string,
  packageName: string,
  subpath: string,
  source: string,
): Promise<void> {
  const directory = path.join(root, "node_modules", packageName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({ type: "module", exports: { [subpath]: "./node.mjs" } }),
  );
  await writeFile(path.join(directory, "node.mjs"), source);
}

function selectedApi(marker: string, version = "5.0.0"): string {
  return `export const version = ${JSON.stringify(version)};
export function parseCLI() { throw new Error(${JSON.stringify(marker)}); }
`;
}

async function startupFailure(root: string): Promise<WatchSnapshot> {
  await command(root, "start", "resolution");
  return waitForSnapshot(root, "resolution", "failed");
}

async function snapshot(root: string, name: string): Promise<WatchSnapshot> {
  const result = await command(root, "snapshot", name);
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
      (await command(root, "status")).stdout,
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

describe.runIf(vitePlusNodeModules)("Vite+ compatibility", () => {
  it.each(["vite-plus", "vitest"])(
    "runs the real Vite+ API installed as %s through watch failure, recovery, output, and shutdown",
    async (packageName) => {
      const root = await createResolutionFixture();
      await symlink(
        path.resolve(vitePlusNodeModules!, "vite-plus"),
        path.join(root, "node_modules", packageName),
      );
      // Check native resolution with the same pnpm NODE_PATH isolation as the CLI.
      const resolved = await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { createRequire } from 'node:module';
const require = createRequire(process.argv[1]);
let standalone;
try { standalone = require.resolve('vitest/node'); }
catch (error) {
  if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
}
console.log(JSON.stringify({ standalone: standalone ?? null, selected: require.resolve(process.argv[2]) }));`,
          path.join(root, "package.json"),
          `${packageName}/test/node`,
        ],
        { encoding: "utf8", timeout: 15_000, env: fixtureEnvironment },
      );
      expect(JSON.parse(resolved.stdout)).toEqual({
        standalone: null,
        selected: expect.stringContaining("vite-plus"),
      });
      await writePassingTest(root, "vite-plus-pass", `${packageName}/test`);
      await command(root, "start", "vite-plus", "--", "--project", "unit");
      expect(await waitForSnapshot(root, "vite-plus", "passed")).toMatchObject({
        counts: { passed: 1, failed: 0, skipped: 0 },
        failures: [],
        unhandledErrors: [],
      });
      expect(
        await waitForOutputMarker(root, "vite-plus", "vite-plus-pass"),
      ).toContain("vite-plus-pass");
      const key = watcherKey(await canonicalRoot(root), "vite-plus");
      const record = await readDiscovery(key);
      expect(record?.pid).toEqual(expect.any(Number));

      await writeFailingTest(root, "vite-plus-failure", `${packageName}/test`);
      expect(await waitForSnapshot(root, "vite-plus", "failed")).toMatchObject({
        counts: { passed: 0, failed: 1, skipped: 0 },
        failures: [
          {
            project: "unit",
            file: "sample.test.mjs",
            test: "sample",
            errors: [
              { message: expect.stringContaining("expected true to be false") },
            ],
          },
        ],
        unhandledErrors: [],
      });
      expect(
        await waitForOutputMarker(
          root,
          "vite-plus",
          "VITE-PLUS-FAILURE-STDERR",
        ),
      ).toContain("VITE-PLUS-FAILURE-STDERR");
      await writePassingTest(
        root,
        "vite-plus-recovered",
        `${packageName}/test`,
      );
      expect(await waitForSnapshot(root, "vite-plus", "passed")).toMatchObject({
        counts: { passed: 1, failed: 0, skipped: 0 },
        failures: [],
        unhandledErrors: [],
      });
      expect(
        await waitForOutputMarker(root, "vite-plus", "vite-plus-recovered"),
      ).toContain("vite-plus-recovered");
      expect((await command(root, "stop", "vite-plus")).stdout).toContain(
        "Stopped vite-plus.",
      );
      expect(() => process.kill(record!.pid!, 0)).toThrow();
      expect(await readDiscovery(key)).toBeUndefined();
      await expect(stat(record!.socket)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    60_000,
  );
});

describe(
  "runner package resolution",
  { concurrent: false, timeout: 30_000 },
  () => {
    it("prefers an existing standalone Vitest API over Vite+", async () => {
      const root = await createResolutionFixture();
      await installNodeApi(
        root,
        "vitest",
        "./node",
        selectedApi("standalone-selected"),
      );
      await installNodeApi(
        root,
        "vite-plus",
        "./test/node",
        selectedApi("vite-plus-selected"),
      );
      expect(await startupFailure(root)).toMatchObject({
        failures: [{ errors: [{ message: "standalone-selected" }] }],
      });
    });

    it.each([
      ["vite-plus", "./test/node"],
      ["vitest", "./test/node"],
    ])(
      "loads the public %s%s API when vitest/node is unavailable",
      async (name, subpath) => {
        const root = await createResolutionFixture();
        await installNodeApi(
          root,
          name,
          subpath,
          selectedApi("fallback-selected"),
        );
        expect(await startupFailure(root)).toMatchObject({
          failures: [{ errors: [{ message: "fallback-selected" }] }],
        });
      },
    );

    it("prefers vite-plus/test/node over the vitest alias entry", async () => {
      const root = await createResolutionFixture();
      await installNodeApi(
        root,
        "vitest",
        "./test/node",
        selectedApi("alias-selected"),
      );
      await installNodeApi(
        root,
        "vite-plus",
        "./test/node",
        selectedApi("vite-plus-selected"),
      );
      expect(await startupFailure(root)).toMatchObject({
        failures: [{ errors: [{ message: "vite-plus-selected" }] }],
      });
    });

    it.each(["vitest", "vite-plus"])(
      "preserves import errors from resolved %s instead of trying another API",
      async (name) => {
        const root = await createResolutionFixture();
        await installNodeApi(
          root,
          "vitest",
          "./test/node",
          selectedApi("alias-selected"),
        );
        await installNodeApi(
          root,
          "vite-plus",
          "./test/node",
          selectedApi("vite-plus-selected"),
        );
        await installNodeApi(
          root,
          name,
          name === "vitest" ? "./node" : "./test/node",
          `import './missing-internal.mjs';`,
        );
        expect(await startupFailure(root)).toMatchObject({
          failures: [
            {
              errors: [
                { message: expect.stringContaining("missing-internal.mjs") },
              ],
            },
          ],
        });
      },
    );

    it("preserves invalid package configuration errors instead of falling back", async () => {
      const root = await createResolutionFixture();
      await installNodeApi(
        root,
        "vitest",
        "./node",
        selectedApi("standalone-selected"),
      );
      await writeFile(
        path.join(root, "node_modules", "vitest", "package.json"),
        "{",
      );
      await installNodeApi(
        root,
        "vite-plus",
        "./test/node",
        selectedApi("vite-plus-selected"),
      );
      expect(await startupFailure(root)).toMatchObject({
        failures: [
          {
            errors: [
              { message: expect.stringContaining("Invalid package config") },
            ],
          },
        ],
      });
    });

    it("names the supported package entry points when none can be resolved", async () => {
      const root = await createResolutionFixture();
      const failed = await startupFailure(root);
      expect(failed).toMatchObject({
        counts: { passed: 0, failed: 0, skipped: 0 },
        failures: [
          {
            errors: [
              {
                message: expect.stringContaining("Cannot resolve vitest/node"),
              },
            ],
          },
        ],
      });
      const message =
        failed.state === "failed" ? failed.failures[0]!.errors[0]!.message : "";
      expect(message).toContain("vite-plus/test/node");
      expect(message).toContain("vitest/test/node");
    });

    it("reports unsupported Vite+ Vitest versions before invoking their API", async () => {
      const root = await createResolutionFixture();
      await installNodeApi(
        root,
        "vite-plus",
        "./test/node",
        selectedApi("must-not-invoke", "4.1.0"),
      );
      const failed = await startupFailure(root);
      expect(failed).toMatchObject({
        failures: [{ errors: [{ message: expect.stringContaining("4.1.0") }] }],
      });
      expect(JSON.stringify(failed)).not.toContain("must-not-invoke");
    });
  },
);

describe("vitest-daemon CLI", { concurrent: false }, () => {
  it.each(["hang", "reject", "socket-lost", "startup-hang"])(
    "verifies process and listener exit when shutdown encounters %s",
    async (mode) => {
      const root = await createFixture("hanging-close");
      await rm(path.join(root, "node_modules"));
      const fake = path.join(root, "node_modules", "vitest");
      await mkdir(fake, { recursive: true });
      await writeFile(
        path.join(fake, "package.json"),
        JSON.stringify({ type: "module", exports: { "./node": "./node.mjs" } }),
      );
      await writeFile(
        path.join(fake, "node.mjs"),
        `
      import { createServer } from 'node:net';
      import { writeFile } from 'node:fs/promises';
      export const parseCLI = () => ({ filter: [], options: {} });
      export async function createVitest() {
        const server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        await writeFile('listener.json', JSON.stringify({ pid: process.pid, port: server.address().port }));
        ${mode === "startup-hang" ? "await new Promise(() => {});" : ""}
        return { reporters: [], start: async () => {}, shouldKeepServer: () => true,
          close: async () => { await writeFile('closing', 'yes'); ${mode === "reject" ? "throw new Error('close failed');" : "await new Promise(() => {});"} } };
      }
    `,
      );
      await command(root, "start", "hang");
      let listener: { pid: number; port: number } | undefined;
      try {
        const deadline = Date.now() + 5000;
        while (!listener && Date.now() < deadline) {
          try {
            listener = JSON.parse(
              await readFile(path.join(root, "listener.json"), "utf8"),
            );
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        expect(listener).toBeDefined();
        const key = watcherKey(await canonicalRoot(root), "hang");
        const record = await readDiscovery(key);
        expect(record?.pid).toBe(listener!.pid);
        if (mode === "socket-lost") {
          await rm(record!.socket);
          await expect(command(root, "status", "hang")).rejects.toThrow(
            "live process",
          );
          await expect(command(root, "start", "hang")).rejects.toThrow(
            "live process",
          );
        }
        const stopping = command(root, "stop", "hang");
        if (mode === "hang") {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            try {
              await readFile(path.join(root, "closing"));
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          expect(
            JSON.parse((await command(root, "status", "hang")).stdout),
          ).toEqual({ status: "stopping" });
          expect(await readDiscovery(key)).toBeDefined();
        }
        const retry =
          mode === "hang" ? command(root, "stop", "hang") : undefined;
        const result = await stopping;
        if (retry) expect((await retry).stdout).toContain("Stopped hang.");
        expect(result.stdout).toContain("Stopped hang.");
        expect(await readDiscovery(key)).toBeUndefined();
        expect(() => process.kill(listener!.pid, 0)).toThrow();
        await expect(
          new Promise<void>((resolve, reject) => {
            const socket = createConnection({
              host: "127.0.0.1",
              port: listener!.port,
            });
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("error", reject);
          }),
        ).rejects.toThrow();
      } finally {
        if (listener) {
          try {
            process.kill(listener.pid, "SIGKILL");
          } catch {}
        }
      }
    },
    20000,
  );

  it("installs the bundled agent skill without overwriting by default", async () => {
    const root = await createFixture("install");
    const destination = path.join(
      root,
      ".agents",
      "skills",
      "vitest-daemon",
      "SKILL.md",
    );
    const source = path.join(
      repositoryRoot,
      ".agents",
      "skills",
      "vitest-daemon",
      "SKILL.md",
    );

    expect((await command(root, "install")).stdout).toContain(
      "Installed vitest-daemon skill",
    );
    expect(await readFile(destination, "utf8")).toBe(
      await readFile(source, "utf8"),
    );

    await writeFile(destination, "customized\n");
    await expect(command(root, "install")).rejects.toThrow(
      "Skill already exists",
    );
    expect(await readFile(destination, "utf8")).toBe("customized\n");

    await command(root, "install", "--force");
    expect(await readFile(destination, "utf8")).toBe(
      await readFile(source, "utf8"),
    );
  });

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
      (await command(root, "status", "unit")).stdout,
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
    expect(await waitForOutputMarker(root, "unit", "lifecycle-fail")).toContain(
      "lifecycle-fail",
    );
    expect(
      await waitForOutputMarker(root, "unit", "LIFECYCLE-FAIL-STDERR"),
    ).toContain("LIFECYCLE-FAIL-STDERR");

    await writePassingTest(root, "lifecycle-recovered");
    const recovered = await waitForSnapshot(root, "unit", "passed");
    expect(recovered).toMatchObject({
      state: "passed",
      counts: { passed: 1, failed: 0, skipped: 0 },
      failures: [],
    });
    expect(
      await waitForOutputMarker(root, "unit", "lifecycle-recovered"),
    ).toContain("lifecycle-recovered");
    expect(
      await waitForOutputMarker(root, "unit", "LIFECYCLE-RECOVERED-STDERR"),
    ).toContain("LIFECYCLE-RECOVERED-STDERR");
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
      (await command(firstRoot, "status")).stdout,
    ) as Array<{ name: string; status: string }>;
    const secondStatuses = JSON.parse(
      (await command(secondRoot, "status")).stdout,
    ) as Array<{ name: string; status: string }>;
    expect(firstStatuses.map(({ name }) => name)).toEqual(["other", "shared"]);
    expect(secondStatuses.map(({ name }) => name)).toEqual(["shared"]);

    const stoppedRecord = await readDiscovery(
      watcherKey(await canonicalRoot(firstRoot), "shared"),
    );
    await command(firstRoot, "stop", "shared");
    expect(() => process.kill(stoppedRecord!.pid!, 0)).toThrow();
    expect(
      JSON.parse((await command(firstRoot, "status", "other")).stdout),
    ).toMatchObject({ status: expect.stringMatching(/starting|running/) });
    expect(
      JSON.parse((await command(secondRoot, "status", "shared")).stdout),
    ).toMatchObject({ status: expect.stringMatching(/starting|running/) });

    await command(firstRoot, "stop", "--all");
    await waitForNoDaemons(firstRoot);
    expect(JSON.parse((await command(firstRoot, "status")).stdout)).toEqual([]);
    expect(
      JSON.parse((await command(secondRoot, "status", "shared")).stdout),
    ).toMatchObject({ status: expect.stringMatching(/starting|running/) });
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
    expect(JSON.parse((await command(root, "status", "unit")).stdout)).toEqual({
      status: "running",
    });
  });

  it("isolates linked git worktrees through watch failure, recovery, and exact-name shutdown", async () => {
    const firstRoot = await createFixture("worktree");
    const secondRoot = `${firstRoot}-linked`;
    fixtures.push(secondRoot);
    const git = (...arguments_: string[]) =>
      execFileAsync("git", ["-C", firstRoot, ...arguments_], {
        encoding: "utf8",
        timeout: 15_000,
      });
    await git("init", "--quiet");
    await git("add", "package.json", "vitest.config.mjs", "sample.test.mjs");
    await git(
      "-c",
      "user.name=Vitest daemon fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "Create disposable test fixture",
    );
    await git("worktree", "add", "--quiet", "--detach", secondRoot);
    await symlink(fixtureNodeModules, path.join(secondRoot, "node_modules"));
    const commonDirectory = async (root: string) => {
      const result = await execFileAsync(
        "git",
        ["-C", root, "rev-parse", "--git-common-dir"],
        { encoding: "utf8" },
      );
      return canonicalRoot(path.resolve(root, result.stdout.trim()));
    };
    expect(await commonDirectory(secondRoot)).toBe(
      await commonDirectory(firstRoot),
    );

    for (const root of [firstRoot, secondRoot]) {
      await command(root, "start", "shared", "--", "--project", "unit");
      expect(await waitForSnapshot(root, "shared", "passed")).toMatchObject({
        counts: { passed: 1, failed: 0, skipped: 0 },
        failures: [],
        unhandledErrors: [],
      });
    }
    const firstKey = watcherKey(await canonicalRoot(firstRoot), "shared");
    const secondKey = watcherKey(await canonicalRoot(secondRoot), "shared");
    expect(firstKey).not.toBe(secondKey);
    const firstRecord = await readDiscovery(firstKey);
    const secondRecord = await readDiscovery(secondKey);
    expect(firstRecord?.pid).toEqual(expect.any(Number));
    expect(secondRecord?.pid).toEqual(expect.any(Number));
    expect(firstRecord!.pid).not.toBe(secondRecord!.pid);
    expect(firstRecord!.socket).not.toBe(secondRecord!.socket);

    await writeFailingTest(firstRoot, "worktree-failure");
    expect(await waitForSnapshot(firstRoot, "shared", "failed")).toMatchObject({
      counts: { passed: 0, failed: 1, skipped: 0 },
      failures: [
        {
          test: "sample",
          errors: [
            expect.objectContaining({
              message: expect.stringContaining("expected true to be false"),
            }),
          ],
        },
      ],
      unhandledErrors: [],
    });
    expect(
      await waitForOutputMarker(firstRoot, "shared", "worktree-failure"),
    ).toContain("worktree-failure");
    expect(await snapshot(secondRoot, "shared")).toMatchObject({
      state: "passed",
      counts: { passed: 1, failed: 0, skipped: 0 },
      failures: [],
    });
    expect((await output(secondRoot, "shared")).toString()).not.toContain(
      "worktree-failure",
    );

    await writePassingTest(firstRoot, "worktree-recovered");
    expect(await waitForSnapshot(firstRoot, "shared", "passed")).toMatchObject({
      counts: { passed: 1, failed: 0, skipped: 0 },
      failures: [],
      unhandledErrors: [],
    });
    expect(
      await waitForOutputMarker(firstRoot, "shared", "worktree-recovered"),
    ).toContain("worktree-recovered");
    expect((await command(firstRoot, "stop", "shared")).stdout).toContain(
      "Stopped shared.",
    );
    expect(() => process.kill(firstRecord!.pid!, 0)).toThrow();
    expect(await readDiscovery(firstKey)).toBeUndefined();
    await expect(stat(firstRecord!.socket)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readDiscovery(secondKey)).toEqual(secondRecord);
    expect(() => process.kill(secondRecord!.pid!, 0)).not.toThrow();
    expect(await snapshot(secondRoot, "shared")).toMatchObject({
      state: "passed",
    });

    await command(secondRoot, "stop", "shared");
    expect(() => process.kill(secondRecord!.pid!, 0)).toThrow();
    expect(await readDiscovery(secondKey)).toBeUndefined();
    await expect(stat(secondRecord!.socket)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);
});
