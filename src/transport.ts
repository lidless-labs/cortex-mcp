import { Transform, type Readable, type Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Includes the encoded 10 MiB file and the JSON-RPC envelope.
export const MAX_MCP_MESSAGE_BYTES = 16 * 1024 * 1024;

export class BoundedStdioServerTransport extends StdioServerTransport {
  private readonly input: Transform;

  constructor(private readonly source: Readable = process.stdin, output: Writable = process.stdout) {
    let lineBytes = 0;
    const input = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        let start = 0;
        for (;;) {
          const end = chunk.indexOf(10, start);
          const length = (end === -1 ? chunk.length : end) - start;
          lineBytes += length;
          if (lineBytes > MAX_MCP_MESSAGE_BYTES) {
            done(new Error("MCP message exceeds byte limit"));
            return;
          }
          if (end === -1) break;
          lineBytes = 0;
          start = end + 1;
        }
        done(null, chunk);
      },
    });
    super(input, output);
    this.input = input;
    input.once("error", () => { void this.close(); });
  }

  override async start(): Promise<void> {
    await super.start();
    this.source.pipe(this.input);
  }

  override async close(): Promise<void> {
    this.source.unpipe(this.input);
    this.source.pause();
    await super.close();
    this.input.destroy();
  }
}
