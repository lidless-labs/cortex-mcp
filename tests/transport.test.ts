import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BoundedStdioServerTransport, MAX_MCP_MESSAGE_BYTES } from "../src/transport.js";

describe("bounded stdio transport", () => {
  it.each([
    { ending: "\n", split: "none" },
    { ending: "\n", split: "payload" },
    { ending: "\r\n", split: "none" },
    { ending: "\r\n", split: "before CR" },
    { ending: "\r\n", split: "after CR" },
  ] as const)("accepts an exact-limit payload with $ending and split=$split", async ({ ending, split }) => {
    const source = new PassThrough(); const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(source, output);
    const messages: unknown[] = []; const errors: string[] = [];
    transport.onmessage = message => messages.push(message);
    transport.onerror = error => errors.push(error.message);
    await transport.start();
    const envelope = { jsonrpc: "2.0", id: 1, method: "ping", params: { example: "" } };
    envelope.params.example = "x".repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(envelope)));
    const encoded = Buffer.from(JSON.stringify(envelope) + ending);
    const splitAt = {
      none: encoded.length,
      payload: 8 * 1024 * 1024,
      "before CR": encoded.length - 2,
      "after CR": encoded.length - 1,
    }[split];
    try {
      source.write(encoded.subarray(0, splitAt));
      if (splitAt < encoded.length) source.write(encoded.subarray(splitAt));
      await new Promise(resolve => setImmediate(resolve));
      expect(errors).toEqual([]);
      expect(messages).toEqual([envelope]);
    } finally {
      await transport.close(); source.destroy(); output.destroy();
    }
  });
  it.each([
    { suffix: ["x"] },
    { suffix: ["x\n"] },
    { suffix: ["\r", "x"] },
    { suffix: ["\r", "\r\n"] },
  ])("closes on oversized input with suffix $suffix", async ({ suffix }) => {
    const source = new PassThrough(); const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(source, output);
    const errors: string[] = []; const messages: unknown[] = [];
    const closed = new Promise<void>(resolve => { transport.onclose = resolve; });
    transport.onerror = error => errors.push(error.message);
    transport.onmessage = message => messages.push(message);
    await transport.start();
    source.write(Buffer.alloc(MAX_MCP_MESSAGE_BYTES / 2, 32));
    source.write(Buffer.alloc(MAX_MCP_MESSAGE_BYTES / 2, 32));
    for (const chunk of suffix) source.write(chunk);
    await closed;
    expect(messages).toHaveLength(0);
    expect(errors).toContain("MCP message exceeds byte limit");
    expect(source.isPaused()).toBe(true);
    source.destroy(); output.destroy();
  });

  it("parses mixed delimiters in order and ignores an unterminated frame at EOF", async () => {
    const source = new PassThrough(); const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(source, output);
    const messages: unknown[] = []; const errors: string[] = [];
    transport.onmessage = message => messages.push(message);
    transport.onerror = error => errors.push(error.message);
    await transport.start();
    try {
      source.write('{"jsonrpc":"2.0","id":1,\r');
      source.write('"method":"ping"}\r');
      source.end('\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}\r');
      await new Promise(resolve => setImmediate(resolve));
      expect(errors).toEqual([]);
      expect(messages).toEqual([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]);
    } finally {
      await transport.close(); source.destroy(); output.destroy();
    }
  });
  it("resets the byte budget for consecutive messages and preserves parsing", async () => {
    const source = new PassThrough(); const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(source, output);
    const messages: unknown[] = [];
    transport.onmessage = message => messages.push(message);
    await transport.start();
    const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { example: "x".repeat(MAX_MCP_MESSAGE_BYTES / 2) } });
    source.write(message + "\n" + message + "\n");
    await new Promise(resolve => setImmediate(resolve));
    expect(messages).toHaveLength(2);
    await transport.close(); source.destroy(); output.destroy();
  });
});
