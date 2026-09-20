export type DaemonLifecycle = "starting" | "running" | "stopping";

export type SnapshotError = {
  name?: string;
  message: string;
  stack?: string;
};

export type SnapshotFailure = {
  project?: string;
  file?: string;
  test?: string;
  errors: SnapshotError[];
};

export type SnapshotCounts = {
  passed: number;
  failed: number;
  skipped: number;
};

export type CheckingSnapshot = {
  state: "checking";
};

export type SettledSnapshot = {
  state: "passed" | "failed";
  counts: SnapshotCounts;
  failures: SnapshotFailure[];
  unhandledErrors: SnapshotError[];
};

export type WatchSnapshot = CheckingSnapshot | SettledSnapshot;

export type DiscoveryRecord = {
  root: string;
  name: string;
  socket: string;
  pid?: number;
  identity?: string;
};

export type JsonRequest =
  | { command: "status" }
  | { command: "snapshot" }
  | { command: "output" }
  | { command: "stop" };

export type JsonResponse =
  | { ok: true; status: DaemonLifecycle }
  | { ok: true; snapshot: WatchSnapshot }
  | { ok: true }
  | { ok: false; error: string };
