/**
 * Offline harness for CortexClient's real fetch/undici request path.
 *
 * Unlike tests/client.test.ts (which stubs global fetch), these exercises go
 * through Node's native fetch backed by undici against a local HTTP server so
 * timeout aborts and response handling stay wired to the production client.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CortexClient } from "../src/client.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJobTools } from "../src/tools/jobs.js";
import { registerResources } from "../src/resources.js";
import type { CortexConfig } from "../src/config.js";

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function scheduleDelayedWrite(
  req: IncomingMessage,
  res: ServerResponse,
  delayMs: number,
  write: () => void,
): void {
  let canceled = false;
  const timer = setTimeout(() => {
    if (canceled || res.writableEnded || res.destroyed) {
      return;
    }
    write();
  }, delayMs);

  const cancel = () => {
    if (canceled) {
      return;
    }
    canceled = true;
    clearTimeout(timer);
  };

  req.once("aborted", cancel);
  req.once("close", cancel);
  res.once("close", cancel);
  res.once("finish", cancel);
}

async function withMockCortex(
  routes: Record<string, RouteHandler>,
  run: (ctx: { baseUrl: string; requests: IncomingMessage[] }) => Promise<void>,
): Promise<void> {
  const requests: IncomingMessage[] = [];
  const connections = new Set<Socket>();
  const server = createServer(async (req, res) => {
    requests.push(req);
    const handler = routes[req.url ?? ""] ?? routes[(req.url ?? "").split("?")[0]];
    if (!handler) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    await handler(req, res);
  });

  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });

  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await run({ baseUrl, requests });
  } finally {
    for (const socket of connections) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function baseConfig(baseUrl: string, timeoutMs: number): CortexConfig {
  return {
    url: baseUrl,
    apiKey: "org-api-key",
    superadminKey: "superadmin-key",
    verifySsl: true,
    timeout: timeoutMs,
    allowDestructive: false,
    maxFanout: 10,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(body);
}

describe("CortexClient HTTP request path (offline)", () => {
  afterEach(() => {
    // Real timers only; no fetch stubs to restore.
  });

  describe("timeout behavior", () => {
    it("maps undici fetch abort to a public timeout error for JSON endpoints", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          "/api/status": (req, res) => {
            scheduleDelayedWrite(req, res, 250, () =>
              json(res, 200, { versions: { Cortex: "3.1.0" } }),
            );
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await expect(client.getStatus()).rejects.toThrow(
            `Cortex API timeout after ${timeoutMs}ms`,
          );
        },
      );
    });

    it("maps undici fetch abort to a public timeout error for text endpoints", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          "/api/user/test-user/key": (req, res) => {
            scheduleDelayedWrite(req, res, 250, () =>
              text(res, 200, "renewed-key-value"),
            );
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await expect(client.getUserKey("test-user")).rejects.toThrow(
            `Cortex API timeout after ${timeoutMs}ms`,
          );
        },
      );
    });

    it("maps undici fetch abort to a public timeout error for POST text endpoints", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          "/api/user/test-user/key/renew": (req, res) => {
            scheduleDelayedWrite(req, res, 250, () =>
              text(res, 200, "renewed-key-value"),
            );
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await expect(client.renewUserKey("test-user")).rejects.toThrow(
            `Cortex API timeout after ${timeoutMs}ms`,
          );
        },
      );
    });

    it("maps undici fetch abort to a public timeout error for multipart uploads", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          "/api/analyzer/test-analyzer/run": (req, res) => {
            scheduleDelayedWrite(req, res, 250, () =>
              json(res, 200, { id: "job-1", status: "Waiting" }),
            );
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await expect(
            client.runAnalyzerWithFile(
              "test-analyzer",
              {
                content: Buffer.from("sample"),
                filename: "sample.txt",
                contentType: "text/plain",
              },
              { tlp: 2, pap: 2 },
            ),
          ).rejects.toThrow(`Cortex API timeout after ${timeoutMs}ms`);
        },
      );
    });
  });

  describe("waitreport timeout", () => {
    const waitReportRoute = "/api/job/job-1/waitreport?atMost=1second";
    const report = {
      id: "job-1",
      status: "Success",
      report: { summary: { taxonomies: [] }, success: true },
    };

    it("waits past the client timeout for the requested wait duration", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          [waitReportRoute]: (req, res) => {
            scheduleDelayedWrite(req, res, 300, () => json(res, 200, report));
          },
        },
        async ({ baseUrl, requests }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          const result = await client.waitAndGetReport("job-1", 1);
          expect(result.status).toBe("Success");
          expect(requests).toHaveLength(1);
          expect(requests[0].headers.authorization).toBe("Bearer org-api-key");
        },
      );
    });

    it("waits past the client timeout when verifySsl is disabled", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          [waitReportRoute]: (req, res) => {
            scheduleDelayedWrite(req, res, 300, () => json(res, 200, report));
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient({
            ...baseConfig(baseUrl, timeoutMs),
            verifySsl: false,
          });

          const result = await client.waitAndGetReport("job-1", 1);
          expect(result.status).toBe("Success");
        },
      );
    });

    it("keeps the configured client timeout for other requests on the same client", async () => {
      const timeoutMs = 80;

      await withMockCortex(
        {
          [waitReportRoute]: (_req, res) => {
            json(res, 200, report);
          },
          "/api/job/job-1/report": (req, res) => {
            scheduleDelayedWrite(req, res, 300, () => json(res, 200, report));
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await client.waitAndGetReport("job-1", 1);
          await expect(client.getJobReport("job-1")).rejects.toThrow(
            `Cortex API timeout after ${timeoutMs}ms`,
          );
        },
      );
    });
  });

  describe("abort semantics", () => {
    it("cancels a delayed server write when the client timeout aborts the fetch", async () => {
      const timeoutMs = 80;
      let delayedWriteRan = false;

      await withMockCortex(
        {
          "/api/status": (req, res) => {
            scheduleDelayedWrite(req, res, 250, () => {
              delayedWriteRan = true;
              json(res, 200, { versions: { Cortex: "3.1.0" } });
            });
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await expect(client.getStatus()).rejects.toThrow(
            `Cortex API timeout after ${timeoutMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(delayedWriteRan).toBe(false);
        },
      );
    });

    it("does not complete a delayed response after the client aborts", async () => {
      const timeoutMs = 80;
      let responseFinished = false;

      await withMockCortex(
        {
          "/api/status": (req, res) => {
            res.once("finish", () => {
              responseFinished = true;
            });
            scheduleDelayedWrite(req, res, 250, () =>
              json(res, 200, { versions: { Cortex: "3.1.0" } }),
            );
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, timeoutMs));

          await expect(client.getStatus()).rejects.toThrow(
            `Cortex API timeout after ${timeoutMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          expect(responseFinished).toBe(false);
        },
      );
    });

    it("returns the response when the server answers before the timeout", async () => {
      await withMockCortex(
        {
          "/api/status": (_req, res) => {
            json(res, 200, {
              versions: { Cortex: "3.1.0" },
              config: { authType: ["key"], capabilities: [] },
            });
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          const status = await client.getStatus();
          expect(status.versions.Cortex).toBe("3.1.0");
        },
      );
    });
  });

  describe("public HTTP error mapping (request)", () => {
    const cases = [
      [401, "Invalid API key or unauthorized access"],
      [403, "Forbidden - insufficient permissions"],
      [404, "Resource not found"],
      [429, "Rate limit exceeded"],
      [500, "Cortex internal server error"],
    ] as const;

    it.each(cases)(
      "maps HTTP %i to %s",
      async (status, message) => {
        await withMockCortex(
          {
            "/api/analyzer": (_req, res) => {
              text(res, status, `body-for-${status}`);
            },
          },
          async ({ baseUrl }) => {
            const client = new CortexClient(baseConfig(baseUrl, 5_000));

            await expect(client.listAnalyzers()).rejects.toThrow(
              `Cortex API error: ${message} - body-for-${status}`,
            );
          },
        );
      },
    );

    it("maps status-specific errors without appending a body suffix when empty", async () => {
      await withMockCortex(
        {
          "/api/analyzer": (_req, res) => {
            res.writeHead(401);
            res.end();
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(client.listAnalyzers()).rejects.toThrow(
            "Cortex API error: Invalid API key or unauthorized access",
          );
        },
      );
    });

    it("returns undefined for successful DELETE with empty body", async () => {
      await withMockCortex(
        {
          "/api/analyzer/to-delete": (_req, res) => {
            res.writeHead(204);
            res.end();
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(
            client.deleteAnalyzer("to-delete"),
          ).resolves.toBeUndefined();
        },
      );
    });

    it("maps unknown status codes with status text and response body", async () => {
      await withMockCortex(
        {
          "/api/analyzer": (_req, res) => {
            text(res, 418, '{"message":"teapot"}');
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(client.listAnalyzers()).rejects.toThrow(
            'Cortex API error: HTTP 418: I\'m a Teapot - {"message":"teapot"}',
          );
        },
      );
    });

    it("sends Authorization and omits Content-Type on GET", async () => {
      await withMockCortex(
        {
          "/api/status": (_req, res) => {
            json(res, 200, {
              versions: { Cortex: "3.1.0" },
              config: { authType: ["key"], capabilities: [] },
            });
          },
        },
        async ({ baseUrl, requests }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));
          await client.getStatus();

          expect(requests).toHaveLength(1);
          expect(requests[0].method).toBe("GET");
          expect(requests[0].headers.authorization).toBe("Bearer org-api-key");
          expect(requests[0].headers["content-type"]).toBeUndefined();
        },
      );
    });

    it("includes Content-Type on POST bodies", async () => {
      await withMockCortex(
        {
          "/api/job/_search": (_req, res) => {
            json(res, 200, []);
          },
        },
        async ({ baseUrl, requests }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));
          await client.searchJobs({
            query: { _field: "status", _value: "*" },
            range: "0-1",
          });

          expect(requests).toHaveLength(1);
          expect(requests[0].method).toBe("POST");
          expect(requests[0].headers["content-type"]).toBe("application/json");
        },
      );
    });
  });

  describe("public HTTP error mapping (requestText)", () => {
    it("maps non-ok text responses without a body suffix when empty", async () => {
      await withMockCortex(
        {
          "/api/user/test-user/key": (_req, res) => {
            res.writeHead(403);
            res.end();
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(client.getUserKey("test-user")).rejects.toThrow(
            "Cortex API error: HTTP 403",
          );
        },
      );
    });

    it("maps non-ok text responses to Cortex API error with status and body", async () => {
      await withMockCortex(
        {
          "/api/user/test-user/key/renew": (_req, res) => {
            text(res, 403, "renew forbidden");
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(client.renewUserKey("test-user")).rejects.toThrow(
            "Cortex API error: HTTP 403 - renew forbidden",
          );
        },
      );
    });

    it("uses the superadmin bearer token for text endpoints", async () => {
      await withMockCortex(
        {
          "/api/user/test-user/key": (_req, res) => {
            text(res, 200, "visible-key");
          },
        },
        async ({ baseUrl, requests }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));
          const key = await client.getUserKey("test-user");

          expect(key).toBe("visible-key");
          expect(requests[0].headers.authorization).toBe(
            "Bearer superadmin-key",
          );
        },
      );
    });
  });

  describe("public HTTP error mapping (runAnalyzerWithFile)", () => {
    it("maps non-ok multipart responses to Cortex API error with status and body", async () => {
      await withMockCortex(
        {
          "/api/analyzer/test-analyzer/run": (_req, res) => {
            text(res, 400, "invalid attachment");
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(
            client.runAnalyzerWithFile(
              "test-analyzer",
              {
                content: Buffer.from("sample"),
                filename: "sample.txt",
                contentType: "text/plain",
              },
              { tlp: 2, pap: 2 },
            ),
          ).rejects.toThrow(
            "Cortex API error: HTTP 400 - invalid attachment",
          );
        },
      );
    });

    it("maps non-ok multipart responses without a body suffix when empty", async () => {
      await withMockCortex(
        {
          "/api/analyzer/test-analyzer/run": (_req, res) => {
            res.writeHead(500);
            res.end();
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient(baseConfig(baseUrl, 5_000));

          await expect(
            client.runAnalyzerWithFile(
              "test-analyzer",
              {
                content: Buffer.from("sample"),
                filename: "sample.txt",
                contentType: "text/plain",
              },
              { tlp: 2, pap: 2 },
            ),
          ).rejects.toThrow("Cortex API error: HTTP 500");
        },
      );
    });
  });

  describe("undici dispatcher path", () => {
    it("succeeds over plain HTTP when verifySsl is disabled", async () => {
      await withMockCortex(
        {
          "/api/status": (_req, res) => {
            json(res, 200, {
              versions: { Cortex: "3.1.0" },
              config: { authType: ["key"], capabilities: [] },
            });
          },
        },
        async ({ baseUrl }) => {
          const client = new CortexClient({
            ...baseConfig(baseUrl, 5_000),
            verifySsl: false,
          });

          const status = await client.getStatus();
          expect(status.versions.Cortex).toBe("3.1.0");
        },
      );
    });
  });
});

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function handlers(client: CortexClient) {
  const tools = new Map<string, Function>();
  const resources = new Map<string, Function>();
  const server = {
    tool(...args: any[]) { tools.set(args[0], args.at(-1)); },
    resource(...args: any[]) { resources.set(args[0], args.at(-1)); },
  } as unknown as McpServer;
  registerJobTools(server, client); registerResources(server, client);
  return { tools, resources };
}

describe("job search pagination on the wire", () => {
  it("sends range and repeated sort parameters outside the JSON query", async () => {
    let body: unknown;
    await withMockCortex({ "/api/job/_search": async (req, res) => { body = await requestBody(req); json(res, 200, []); } }, async ({ baseUrl, requests }) => {
      const client = new CortexClient(baseConfig(baseUrl, 5000));
      const query = { _field: "status", _value: "Success" };
      await client.searchJobs({ query, range: "0-50", sort: ["-createdAt", "+status"] });
      const url = new URL(requests[0].url!, baseUrl);
      expect(url.searchParams.get("range")).toBe("0-50");
      expect(url.searchParams.getAll("sort")).toEqual(["-createdAt", "+status"]);
      expect(body).toEqual({ query });
    });
  });
  it.each(["list", "cleanup", "resource"])("uses an empty match-all query for %s and honors its limit", async kind => {
    let body: unknown;
    await withMockCortex({ "/api/job/_search": async (req, res) => { body = await requestBody(req); json(res, 200, []); } }, async ({ baseUrl, requests }) => {
      const { tools, resources } = handlers(new CortexClient(baseConfig(baseUrl, 5000)));
      if (kind === "list") await tools.get("cortex_list_jobs")!({ limit: 5 });
      else if (kind === "cleanup") await tools.get("cortex_cleanup_jobs")!({ limit: 5, olderThanDays: 30, dryRun: true });
      else await resources.get("recent-jobs")!();
      expect(requests).toHaveLength(1);
      const url = new URL(requests[0].url!, baseUrl);
      expect(url.searchParams.get("range")).toBe(kind === "resource" ? "0-50" : "0-5");
      expect(url.searchParams.getAll("sort")).toEqual(["-createdAt"]);
      expect(body).toEqual({ query: {} });
    });
  });
  it("omits absent paging options and sends an empty query by default", async () => {
    let body: unknown;
    await withMockCortex({ "/api/job/_search": async (req, res) => { body = await requestBody(req); json(res, 200, []); } }, async ({ baseUrl, requests }) => {
      await new CortexClient(baseConfig(baseUrl, 5000)).searchJobs({});
      expect(requests[0].url).toBe("/api/job/_search");
      expect(body).toEqual({ query: {} });
    });
  });
});
