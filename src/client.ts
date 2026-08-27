import { createConnection } from "node:net";

import type { JsonRequest, JsonResponse } from "./types.js";

export async function requestJson(
  socket: string,
  request: Exclude<JsonRequest, { command: "output" }>,
): Promise<JsonResponse> {
  const response = await requestBuffer(socket, request);
  try {
    return JSON.parse(response.toString("utf8")) as JsonResponse;
  } catch {
    throw new Error("The daemon returned an invalid response.");
  }
}

export function requestBuffer(
  socket: string,
  request: JsonRequest,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const connection = createConnection(socket);
    connection.once("connect", () => {
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    connection.once("end", () => resolve(Buffer.concat(chunks)));
    connection.once("error", reject);
  });
}
