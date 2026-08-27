import { describe, expect, it } from "vitest";
import type { TestModule } from "vitest/node";

import { SnapshotReporter } from "../src/snapshot-reporter.js";
import type { WatchSnapshot } from "../src/types.js";

function moduleWithTests(
  states: Array<"passed" | "failed" | "skipped">,
): TestModule {
  const tests = states.map((state, index) => ({
    fullName: `suite > test ${index}`,
    module: {
      project: { name: "unit" },
      relativeModuleId: "test/example.test.ts",
    },
    result: () => ({
      state,
      errors:
        state === "failed"
          ? [
              Object.assign(new Error("expected true"), {
                name: "AssertionError",
              }),
            ]
          : undefined,
    }),
  }));
  return {
    project: { name: "unit" },
    relativeModuleId: "test/example.test.ts",
    errors: () => [],
    children: {
      allTests: function* () {
        yield* tests;
      },
    },
  } as unknown as TestModule;
}

describe("SnapshotReporter", () => {
  it("replaces settled state with checking when another check begins", () => {
    let current: WatchSnapshot = { state: "checking" };
    const reporter = new SnapshotReporter((snapshot) => {
      current = snapshot;
    });

    reporter.onTestRunEnd([moduleWithTests(["passed"])], [], "passed");
    expect(current).toMatchObject({ state: "passed" });

    reporter.onWatcherRerun();
    expect(current).toEqual({ state: "checking" });
  });

  it("summarizes failures without adding daemon metadata", () => {
    let current: WatchSnapshot = { state: "checking" };
    const reporter = new SnapshotReporter((snapshot) => {
      current = snapshot;
    });

    reporter.onTestRunEnd(
      [moduleWithTests(["passed", "failed", "skipped"])],
      [],
      "failed",
    );

    expect(current).toMatchObject({
      state: "failed",
      counts: { passed: 1, failed: 1, skipped: 1 },
      failures: [
        {
          project: "unit",
          file: "test/example.test.ts",
          test: "suite > test 1",
          errors: [{ name: "AssertionError", message: "expected true" }],
        },
      ],
      unhandledErrors: [],
    });
    expect(Object.keys(current)).not.toContain("pid");
    expect(Object.keys(current)).not.toContain("version");
  });
});
