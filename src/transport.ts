import { Transform, type Readable, type Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Includes the encoded 10 MiB file and the JSON-RPC envelope.
export const MAX_MCP_MESSAGE_BYTES = 16 * 1024 * 1024;
const FRAME_BLOCK_BYTES = 64 * 1024;
const LF = 10;
const CR = 13;

export class BoundedStdioServerTransport extends StdioServerTransport {
  private readonly input: Transform;

  constructor(private readonly source: Readable = process.stdin, output: Writable = process.stdout) {
    const blocks: Buffer[] = [];
    let bufferedBytes = 0;
    const clearFrame = () => {
      blocks.length = 0;
      bufferedBytes = 0;
    };
    const input = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        let start = 0;
        while (start < chunk.length) {
          const end = chunk.indexOf(LF, start);
          const segmentEnd = end === -1 ? chunk.length : end;
          const tail = blocks.at(-1);
          const tailBytes = tail ? ((bufferedBytes - 1) % FRAME_BLOCK_BYTES) + 1 : 0;
          const lastByte = segmentEnd > start ? chunk[segmentEnd - 1] : tail?.[tailBytes - 1];
          const frameBytes = bufferedBytes + segmentEnd - start;
          // A trailing CR can be part of CRLF even if the LF has yet to arrive.
          if (frameBytes - (lastByte === CR ? 1 : 0) > MAX_MCP_MESSAGE_BYTES) {
            done(new Error("MCP message exceeds byte limit"));
            return;
          }

          if (end === -1) {
            // Pack partial input so tiny source chunks cannot create an unbounded list.
            while (start < chunk.length) {
              const offset = bufferedBytes % FRAME_BLOCK_BYTES;
              if (offset === 0) blocks.push(Buffer.allocUnsafe(FRAME_BLOCK_BYTES));
              const length = Math.min(chunk.length - start, FRAME_BLOCK_BYTES - offset);
              chunk.copy(blocks[blocks.length - 1], offset, start, start + length);
              bufferedBytes += length;
              start += length;
            }
            break;
          }

          // Give the SDK a complete frame so it does not re-copy partial input.
          const segment = chunk.subarray(start, end + 1);
          if (tail) {
            blocks[blocks.length - 1] = tail.subarray(0, tailBytes);
            const frame = Buffer.concat([...blocks, segment], frameBytes + 1);
            clearFrame();
            this.push(frame);
          } else {
            this.push(segment);
          }
          start = end + 1;
        }
        done();
      },
      flush(done) {
        clearFrame();
        done();
      },
      destroy(error, done) {
        clearFrame();
        done(error);
      },
    });
    // The SDK strips CRLF. Its buffer includes the delimiter, while our limit does not.
    super(input, output, { maxBufferSize: MAX_MCP_MESSAGE_BYTES + 2 });
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
