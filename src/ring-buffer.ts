import { Writable } from "node:stream";

export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export class ByteRingBuffer {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #length = 0;

  constructor(limit = DEFAULT_OUTPUT_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("The output limit must be a positive integer.");
    }
    this.#limit = limit;
  }

  append(value: Uint8Array | string): void {
    const chunk = Buffer.isBuffer(value)
      ? Buffer.from(value)
      : Buffer.from(value);
    if (chunk.length >= this.#limit) {
      this.#chunks = [chunk.subarray(chunk.length - this.#limit)];
      this.#length = this.#limit;
      return;
    }

    this.#chunks.push(chunk);
    this.#length += chunk.length;
    while (this.#length > this.#limit) {
      const first = this.#chunks[0];
      if (!first) break;
      const excess = this.#length - this.#limit;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#length -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#length -= excess;
      }
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#length);
  }

  createWritable(): Writable {
    return new Writable({
      write: (chunk: Buffer | string, encoding, callback) => {
        try {
          this.append(
            typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk,
          );
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
  }
}
