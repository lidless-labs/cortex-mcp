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
    const handler = routes[req.url ?? ""];
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
