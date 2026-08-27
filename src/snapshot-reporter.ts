import type {
  Reporter,
  SerializedError,
  TestCase,
  TestModule,
  TestRunEndReason,
} from "vitest/node";

import type { SnapshotError, SnapshotFailure, WatchSnapshot } from "./types.js";

type SnapshotSink = (snapshot: WatchSnapshot) => void;

function serializeError(error: unknown): SnapshotError {
  if (error instanceof Error) {
    return {
      ...(error.name ? { name: error.name } : {}),
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      name?: unknown;
      message?: unknown;
      stack?: unknown;
    };
    return {
      ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : JSON.stringify(error),
      ...(typeof candidate.stack === "string"
        ? { stack: candidate.stack }
        : {}),
    };
  }
  return { message: String(error) };
}

function testFailure(test: TestCase): SnapshotFailure {
  return {
    ...(test.module.project.name
      ? { project: String(test.module.project.name) }
      : {}),
    file: test.module.relativeModuleId,
    test: test.fullName,
    errors: (test.result().errors ?? []).map(serializeError),
  };
}

function moduleFailure(module: TestModule): SnapshotFailure | undefined {
  const errors = module.errors().map(serializeError);
  if (errors.length === 0) return undefined;
  return {
    ...(module.project.name ? { project: String(module.project.name) } : {}),
    file: module.relativeModuleId,
    errors,
  };
}

export class SnapshotReporter implements Reporter {
  readonly #sink: SnapshotSink;

  constructor(sink: SnapshotSink) {
    this.#sink = sink;
  }

  onWatcherRerun(): void {
    this.#sink({ state: "checking" });
  }

  onTestRunStart(): void {
    this.#sink({ state: "checking" });
  }

  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    const failures: SnapshotFailure[] = [];

    for (const module of modules) {
      const collectionFailure = moduleFailure(module);
      if (collectionFailure) failures.push(collectionFailure);

      for (const test of module.children.allTests()) {
        const state = test.result().state;
        if (state === "passed") counts.passed += 1;
        else if (state === "failed") {
          counts.failed += 1;
          failures.push(testFailure(test));
        } else if (state === "skipped") counts.skipped += 1;
      }
    }

    const serializedUnhandledErrors = unhandledErrors.map(serializeError);
    this.#sink({
      state:
        reason === "passed" &&
        failures.length === 0 &&
        serializedUnhandledErrors.length === 0
          ? "passed"
          : "failed",
      counts,
      failures,
      unhandledErrors: serializedUnhandledErrors,
    });
  }
}
