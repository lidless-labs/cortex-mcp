import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BoundedStdioServerTransport, MAX_MCP_MESSAGE_BYTES } from "../src/transport.js";

describe("bounded stdio transport", () => {
  it.each([false, true])("accepts a message at the 16 MiB limit, fragmented=%s", async fragmented => {
    const source = new PassThrough(); const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(source, output);
    const messages: unknown[] = []; const errors: string[] = [];
    transport.onmessage = message => messages.push(message);
    transport.onerror = error => errors.push(error.message);
    await transport.start();
    const envelope = { jsonrpc: "2.0", id: 1, method: "ping", params: { example: "" } };
    envelope.params.example = "x".repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(envelope)));
    const encoded = Buffer.from(JSON.stringify(envelope) + "\n");
    try {
      if (fragmented) {
        source.write(encoded.subarray(0, 8 * 1024 * 1024));
        source.write(encoded.subarray(8 * 1024 * 1024));
      } else {
        source.write(encoded);
      }
      await new Promise(resolve => setImmediate(resolve));
      expect(errors).toEqual([]);
      expect(messages).toEqual([envelope]);
    } finally {
      await transport.close(); source.destroy(); output.destroy();
    }
  });
  it.each([false, true])("closes on fragmented oversized input, newline=%s", async newline => {
    const source = new PassThrough(); const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(source, output);
    const errors: string[] = []; const messages: unknown[] = [];
    const closed = new Promise<void>(resolve => { transport.onclose = resolve; });
    transport.onerror = error => errors.push(error.message);
    transport.onmessage = message => messages.push(message);
    await transport.start();
    source.write(Buffer.alloc(MAX_MCP_MESSAGE_BYTES / 2, 32));
    source.write(Buffer.alloc(MAX_MCP_MESSAGE_BYTES / 2, 32));
    source.write(newline ? "x\n" : "x");
    await closed;
    expect(messages).toHaveLength(0);
    expect(errors).toContain("MCP message exceeds byte limit");
    expect(source.isPaused()).toBe(true);
    source.destroy(); output.destroy();
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
