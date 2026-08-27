import { describe, expect, it } from "vitest";

import { ByteRingBuffer } from "../src/ring-buffer.js";

describe("ByteRingBuffer", () => {
  it("preserves appended bytes exactly", () => {
    const buffer = new ByteRingBuffer(32);
    buffer.append(Buffer.from([0, 1, 2, 255]));
    buffer.append("hello\n");

    expect(buffer.toBuffer()).toEqual(
      Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from("hello\n")]),
    );
  });

  it("retains only the configured byte tail", () => {
    const buffer = new ByteRingBuffer(5);
    buffer.append("abc");
    buffer.append("defgh");

    expect(buffer.toBuffer().toString()).toBe("defgh");
  });

  it("handles a partial first-chunk eviction", () => {
    const buffer = new ByteRingBuffer(6);
    buffer.append("abcd");
    buffer.append("efgh");

    expect(buffer.toBuffer().toString()).toBe("cdefgh");
  });
});
