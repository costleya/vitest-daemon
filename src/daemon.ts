import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  removeDiscovery,
  socketAddress,
  watcherKey,
  writeDiscovery,
} from "./discovery.js";
import { ByteRingBuffer } from "./ring-buffer.js";
import { SnapshotReporter } from "./snapshot-reporter.js";
import type {
  DaemonLifecycle,
  JsonRequest,
  JsonResponse,
  WatchSnapshot,
} from "./types.js";

type DaemonOptions = {
  root: string;
  name: string;
  vitestArguments: string[];
};

type VitestContext = {
  close(): Promise<void>;
  shouldKeepServer(): boolean;
  start(filters?: string[]): Promise<unknown>;
  reporters: unknown[];
};

type VitestNode = {
  parseCLI(arguments_: string[]): {
    filter: string[];
    options: Record<string, unknown>;
  };
  createVitest(
    mode: "test",
    options: Record<string, unknown>,
    viteOverrides: Record<string, unknown>,
    vitestOptions: Record<string, unknown>,
  ): Promise<VitestContext>;
};

function json(response: JsonResponse): Buffer {
  return Buffer.from(JSON.stringify(response));
}

async function loadVitest(root: string): Promise<VitestNode> {
  const packageRequire = createRequire(path.join(root, "package.json"));
  let modulePath: string;
  try {
    modulePath = packageRequire.resolve("vitest/node");
  } catch {
    throw new Error(`Cannot resolve vitest/node from ${root}.`);
  }
  return import(pathToFileURL(modulePath).href) as Promise<VitestNode>;
}

function readRequest(socket: Socket): Promise<JsonRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
      const request = Buffer.concat(chunks);
      const newline = request.indexOf(0x0a);
      if (newline === -1) return;
      socket.off("data", onData);
      try {
        resolve(
          JSON.parse(
            request.subarray(0, newline).toString("utf8"),
          ) as JsonRequest,
        );
      } catch {
        reject(new Error("Invalid daemon request."));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

export async function runDaemon(options: DaemonOptions): Promise<void> {
  const key = watcherKey(options.root, options.name);
  const socket = socketAddress(key);
  const output = new ByteRingBuffer();
  const outputStream = output.createWritable();
  let lifecycle: DaemonLifecycle = "starting";
  let snapshot: WatchSnapshot = { state: "checking" };
  let vitest: VitestContext | undefined;
  let shuttingDown = false;

  const reporter = new SnapshotReporter((value) => {
    snapshot = value;
  });

  const server: Server = createServer((connection) => {
    void readRequest(connection)
      .then(async (request) => {
        if (request.command === "output") {
          connection.end(output.toBuffer());
          return;
        }
        if (request.command === "status") {
          connection.end(json({ ok: true, status: lifecycle }));
          return;
        }
        if (request.command === "snapshot") {
          connection.end(json({ ok: true, snapshot }));
          return;
        }
        if (request.command === "stop") {
          connection.end(json({ ok: true }));
          void shutdown();
          return;
        }
        connection.end(json({ ok: false, error: "Unknown daemon command." }));
      })
      .catch((error: unknown) => {
        connection.end(
          json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
  });

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle = "stopping";
    server.close();
    try {
      await vitest?.close();
    } finally {
      await removeDiscovery(key);
      process.exitCode = 0;
    }
  }

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  await writeDiscovery(key, {
    root: options.root,
    name: options.name,
    socket,
  });

  if (process.send) {
    process.send({ ready: true });
    process.disconnect();
  }

  try {
    const vitestNode = await loadVitest(options.root);
    const parsed = vitestNode.parseCLI(["vitest", ...options.vitestArguments]);
    parsed.options.root = options.root;
    parsed.options.watch = true;
    parsed.options.run = false;

    vitest = await vitestNode.createVitest(
      "test",
      parsed.options,
      {},
      { stdout: outputStream, stderr: outputStream },
    );
    vitest.reporters.push(reporter);
    await vitest.start(parsed.filter);
    if (!vitest.shouldKeepServer()) {
      throw new Error("Vitest did not remain in watch mode.");
    }
    if (shuttingDown) {
      await vitest.close();
      return;
    }
    lifecycle = "running";
  } catch (error) {
    snapshot = {
      state: "failed",
      counts: { passed: 0, failed: 0, skipped: 0 },
      failures: [
        {
          errors: [
            {
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof Error && error.stack
                ? { stack: error.stack }
                : {}),
            },
          ],
        },
      ],
      unhandledErrors: [],
    };
    lifecycle = "running";
  }
}
