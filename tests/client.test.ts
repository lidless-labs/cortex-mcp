import { describe, it, expect, vi, beforeEach } from "vitest";

// Record the options each undici Agent is built with, so tests can check the
// dispatcher a request was sent through without reaching into undici internals.
const agentOptions = vi.hoisted(() => new Map<object, unknown>());
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  class RecordingAgent extends actual.Agent {
    constructor(options?: ConstructorParameters<typeof actual.Agent>[0]) {
      super(options);
      agentOptions.set(this, options);
    }
  }
  return { ...actual, Agent: RecordingAgent };
});

import { CortexClient } from "../src/client.js";
import type { CortexConfig } from "../src/config.js";
import type {
  Analyzer,
  Job,
  JobReport,
  Artifact,
  Responder,
  ActionJob,
} from "../src/types.js";

// Mock data
const mockAnalyzer: Analyzer = {
  id: "VirusTotal_GetReport_3_1",
  name: "VirusTotal_GetReport",
  version: "3.1",
  description: "Get a report from VirusTotal for an observable",
  dataTypeList: ["hash", "ip", "domain", "url"],
};

const mockJob: Job = {
  id: "AWl2d8x1kDx6FO7wxPBn",
  analyzerId: "VirusTotal_GetReport_3_1",
  analyzerName: "VirusTotal_GetReport",
  status: "Success",
  data: "8.8.8.8",
  dataType: "ip",
  tlp: 2,
  pap: 2,
  startDate: 1706745600000,
  endDate: 1706745615000,
  createdAt: 1706745600000,
};

const mockJobReport: JobReport = {
  ...mockJob,
  report: {
    summary: {
      taxonomies: [
        {
          level: "info",
          namespace: "VT",
          predicate: "GetReport",
          value: "0/87",
        },
      ],
    },
    full: {
      positives: 0,
      total: 87,
      scan_date: "2024-01-31",
    },
    success: true,
  },
};

const mockArtifact: Artifact = {
  dataType: "domain",
  data: "dns.google",
  message: "Related domain found",
  tlp: 2,
  tags: ["dns"],
};

const mockResponder: Responder = {
  id: "Mailer_1_0",
  name: "Mailer",
  version: "1.0",
  description: "Send an email notification",
  dataTypeList: ["case", "case_artifact", "alert"],
};

const mockActionJob: ActionJob = {
  id: "action_123",
  responderId: "Mailer_1_0",
  responderName: "Mailer",
  status: "Success",
  objectType: "case_artifact",
  objectId: "artifact_456",
};

const config: CortexConfig = {
  url: "https://cortex.example.com:9001",
  apiKey: "test-api-key-123",
  verifySsl: true,
  timeout: 30000,
  allowDestructive: false,
  maxFanout: 10,
};

describe("CortexClient", () => {
  let client: CortexClient;

  beforeEach(() => {
    client = new CortexClient(config);
    vi.restoreAllMocks();
  });

  describe("listAnalyzers", () => {
    it("should fetch all analyzers", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([mockAnalyzer]), { status: 200 }),
      );

      const result = await client.listAnalyzers();

      expect(result).toEqual([mockAnalyzer]);
      expect(fetch).toHaveBeenCalledWith(
        "https://cortex.example.com:9001/api/analyzer",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-api-key-123",
          }),
        }),
      );
    });
  });

  describe("getAnalyzer", () => {
    it("should fetch a specific analyzer", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockAnalyzer), { status: 200 }),
      );

      const result = await client.getAnalyzer("VirusTotal_GetReport_3_1");

      expect(result).toEqual(mockAnalyzer);
      expect(fetch).toHaveBeenCalledWith(
        "https://cortex.example.com:9001/api/analyzer/VirusTotal_GetReport_3_1",
        expect.anything(),
      );
    });
  });

  describe("runAnalyzer", () => {
    it("should submit an observable for analysis", async () => {
      const submittedJob: Job = { ...mockJob, status: "Waiting" };
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(submittedJob), { status: 200 }),
      );

      const result = await client.runAnalyzer("VirusTotal_GetReport_3_1", {
        data: "8.8.8.8",
        dataType: "ip",
        tlp: 2,
        pap: 2,
      });

      expect(result.status).toBe("Waiting");
      expect(fetch).toHaveBeenCalledWith(
        "https://cortex.example.com:9001/api/analyzer/VirusTotal_GetReport_3_1/run",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            data: "8.8.8.8",
            dataType: "ip",
            tlp: 2,
            pap: 2,
          }),
        }),
      );
    });

    it("should include optional message in request body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockJob), { status: 200 }),
      );

      await client.runAnalyzer("VirusTotal_GetReport_3_1", {
        data: "8.8.8.8",
        dataType: "ip",
        tlp: 2,
        pap: 2,
        message: "Check this suspicious IP",
      });

      const callArgs = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(callArgs[1]?.body as string);
      expect(body.message).toBe("Check this suspicious IP");
    });
  });

  describe("getJob", () => {
    it("should fetch job status", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockJob), { status: 200 }),
      );

      const result = await client.getJob("AWl2d8x1kDx6FO7wxPBn");

      expect(result.status).toBe("Success");
      expect(result.id).toBe("AWl2d8x1kDx6FO7wxPBn");
    });
  });

  describe("getJobReport", () => {
    it("should fetch full job report with taxonomies", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockJobReport), { status: 200 }),
      );

      const result = await client.getJobReport("AWl2d8x1kDx6FO7wxPBn");

      expect(result.report?.summary?.taxonomies).toHaveLength(1);
      expect(result.report?.summary?.taxonomies?.[0].level).toBe("info");
      expect(result.report?.full).toBeDefined();
    });
  });

  describe("waitAndGetReport", () => {
    it("should call waitreport endpoint with timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockJobReport), { status: 200 }),
      );

      const result = await client.waitAndGetReport("AWl2d8x1kDx6FO7wxPBn", 120);

      expect(result.status).toBe("Success");
      expect(fetch).toHaveBeenCalledWith(
        "https://cortex.example.com:9001/api/job/AWl2d8x1kDx6FO7wxPBn/waitreport?atMost=120second",
        expect.anything(),
      );
    });

    it("should use default 300 second timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockJobReport), { status: 200 }),
      );

      await client.waitAndGetReport("AWl2d8x1kDx6FO7wxPBn");

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("atMost=300second"),
        expect.anything(),
      );
    });

    it("sends the wait through a reused dispatcher with undici header/body timeouts disabled", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () =>
          new Response(JSON.stringify(mockJobReport), { status: 200 }),
        );

      await client.waitAndGetReport("AWl2d8x1kDx6FO7wxPBn", 3600);
      await client.waitAndGetReport("AWl2d8x1kDx6FO7wxPBn", 3600);

      const first = fetchSpy.mock.calls[0][1] as Record<string, unknown>;
      const second = fetchSpy.mock.calls[1][1] as Record<string, unknown>;
      expect(first.dispatcher).toBeDefined();
      expect(second.dispatcher).toBe(first.dispatcher);
      // undici defaults both to 300 s, which would cut off the default
      // 300 s wait and anything longer; 0 leaves the abort timer in charge.
      expect(agentOptions.get(first.dispatcher as object)).toMatchObject({
        headersTimeout: 0,
        bodyTimeout: 0,
      });
    });

    it("keeps the scoped TLS relaxation on the wait dispatcher when verifySsl is disabled", async () => {
      const insecureClient = new CortexClient({ ...config, verifySsl: false });
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify(mockJobReport), { status: 200 }),
        );

      await insecureClient.waitAndGetReport("AWl2d8x1kDx6FO7wxPBn", 60);

      const init = fetchSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(agentOptions.get(init.dispatcher as object)).toMatchObject({
        headersTimeout: 0,
        bodyTimeout: 0,
        connect: { rejectUnauthorized: false },
      });
    });

    it.each([
      // [client timeout ms, requested wait s, expected abort after ms]
      [30_000, 60, 70_000],
      [30_000, 1, 30_000],
    ])(
      "with a %ims client timeout, a %is wait aborts after %ims",
      async (clientTimeoutMs, waitSeconds, expectedMs) => {
        vi.useFakeTimers();
        try {
          const waitClient = new CortexClient({ ...config, timeout: clientTimeoutMs });
          let signal: AbortSignal | undefined;
          vi.spyOn(globalThis, "fetch").mockImplementation(
            (_url, init) =>
              new Promise<Response>((_resolve, reject) => {
                signal = init?.signal ?? undefined;
                signal?.addEventListener("abort", () =>
                  reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                );
              }),
          );

          const pending = waitClient.waitAndGetReport("AWl2d8x1kDx6FO7wxPBn", waitSeconds);
          const rejection = expect(pending).rejects.toThrow(
            `Cortex API timeout after ${expectedMs}ms`,
          );

          await vi.advanceTimersByTimeAsync(expectedMs - 1);
          expect(signal?.aborted).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          expect(signal?.aborted).toBe(true);
          await rejection;
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  describe("searchJobs", () => {
    it("should search jobs with query", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([mockJob]), { status: 200 }),
      );

      const result = await client.searchJobs({
        query: { _field: "dataType", _value: "ip" },
        range: "0-10",
        sort: ["-createdAt"],
      });

      expect(result).toHaveLength(1);
      expect(fetch).toHaveBeenCalledWith(
        "https://cortex.example.com:9001/api/job/_search?range=0-10&sort=-createdAt",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });

  describe("getJobArtifacts", () => {
    it("should fetch extracted artifacts", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([mockArtifact]), { status: 200 }),
      );

      const result = await client.getJobArtifacts("AWl2d8x1kDx6FO7wxPBn");

      expect(result).toHaveLength(1);
      expect(result[0].dataType).toBe("domain");
      expect(result[0].data).toBe("dns.google");
    });
  });

  describe("listResponders", () => {
    it("should fetch all responders", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify([mockResponder]), { status: 200 }),
      );

      const result = await client.listResponders();

      expect(result).toEqual([mockResponder]);
    });
  });

  describe("runResponder", () => {
    it("should execute a responder action", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(mockActionJob), { status: 200 }),
      );

      const result = await client.runResponder("Mailer_1_0", {
        objectType: "case_artifact",
        objectId: "artifact_456",
      });

      expect(result.status).toBe("Success");
      expect(fetch).toHaveBeenCalledWith(
        "https://cortex.example.com:9001/api/responder/Mailer_1_0/run",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should throw on 401 unauthorized", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

      await expect(client.listAnalyzers()).rejects.toThrow(
        "Invalid API key or unauthorized access",
      );
    });

    it("should throw on 404 not found", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Not Found", { status: 404 }),
      );

      await expect(client.getAnalyzer("nonexistent")).rejects.toThrow(
        "Resource not found",
      );
    });

    it("should throw on 500 server error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      await expect(client.listAnalyzers()).rejects.toThrow(
        "Cortex internal server error",
      );
    });

    it("should throw on 429 rate limit", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Too Many Requests", { status: 429 }),
      );

      await expect(client.listAnalyzers()).rejects.toThrow(
        "Rate limit exceeded",
      );
    });

    it("should include response body in error message", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response('{"message":"analyzer disabled"}', { status: 400 }),
      );

      await expect(client.listAnalyzers()).rejects.toThrow(
        'analyzer disabled',
      );
    });
  });
});
