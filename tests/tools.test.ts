import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CortexClient } from "../src/client.js";
import { registerAnalyzerTools } from "../src/tools/analyzers.js";
import { registerJobTools } from "../src/tools/jobs.js";
import { registerResponderTools } from "../src/tools/responders.js";
import { registerBulkTools } from "../src/tools/bulk.js";
import type {
  Analyzer,
  Job,
  JobReport,
  Artifact,
  Responder,
  ActionJob,
} from "../src/types.js";

function parseData(text: string): any {
  return JSON.parse(text.split("<untrusted_cortex_data>\n")[1].split("\n</untrusted_cortex_data>")[0]);
}

// Mock data
const mockAnalyzers: Analyzer[] = [
  {
    id: "VirusTotal_GetReport_3_1",
    name: "VirusTotal_GetReport",
    version: "3.1",
    description: "Get VirusTotal report",
    dataTypeList: ["hash", "ip", "domain", "url"],
  },
  {
    id: "AbuseIPDB_1_0",
    name: "AbuseIPDB",
    version: "1.0",
    description: "Check IP reputation on AbuseIPDB",
    dataTypeList: ["ip"],
  },
  {
    id: "URLhaus_2_0",
    name: "URLhaus",
    version: "2.0",
    description: "Check URL against URLhaus database",
    dataTypeList: ["url", "domain"],
  },
];

const mockJob: Job = {
  id: "job_abc123",
  analyzerId: "VirusTotal_GetReport_3_1",
  analyzerName: "VirusTotal_GetReport",
  status: "Waiting",
  data: "8.8.8.8",
  dataType: "ip",
  tlp: 2,
  pap: 2,
  createdAt: 1706745600000,
};

const mockJobReport: JobReport = {
  id: "job_abc123",
  analyzerId: "VirusTotal_GetReport_3_1",
  analyzerName: "VirusTotal_GetReport",
  status: "Success",
  data: "8.8.8.8",
  dataType: "ip",
  tlp: 2,
  pap: 2,
  report: {
    summary: {
      taxonomies: [
        {
          level: "malicious",
          namespace: "VT",
          predicate: "GetReport",
          value: "5/87",
        },
      ],
    },
    full: { positives: 5, total: 87 },
    success: true,
  },
};

const mockArtifacts: Artifact[] = [
  {
    dataType: "domain",
    data: "malware.example.com",
    tlp: 2,
    tags: ["malware", "c2"],
  },
  {
    dataType: "ip",
    data: "192.0.2.100",
    tlp: 2,
    tags: ["internal"],
  },
];

const mockResponders: Responder[] = [
  {
    id: "Mailer_1_0",
    name: "Mailer",
    version: "1.0",
    description: "Send email notification",
    dataTypeList: ["case", "case_artifact", "alert"],
  },
];

const mockActionJob: ActionJob = {
  id: "action_789",
  responderId: "Mailer_1_0",
  responderName: "Mailer",
  status: "Success",
  objectType: "case_artifact",
  objectId: "artifact_456",
};

// Helper to extract registered tool handler from McpServer
function createMockClient(
  settings: {
    fileBaseDir?: string;
    allowDestructive?: boolean;
    maxFanout?: number;
  } = {},
) {
  return {
    listAnalyzers: vi.fn<() => Promise<Analyzer[]>>(),
    getAnalyzer: vi.fn<(id: string) => Promise<Analyzer>>(),
    runAnalyzer: vi.fn<(id: string, data: unknown) => Promise<Job>>(),
    getJob: vi.fn<(id: string) => Promise<Job>>(),
    getJobReport: vi.fn<(id: string) => Promise<JobReport>>(),
    waitAndGetReport: vi.fn<(id: string, timeout?: number) => Promise<JobReport>>(),
    searchJobs: vi.fn<(query: unknown) => Promise<Job[]>>(),
    getJobArtifacts: vi.fn<(id: string) => Promise<Artifact[]>>(),
    deleteJob: vi.fn<(id: string) => Promise<void>>(),
    listResponders: vi.fn<() => Promise<Responder[]>>(),
    runResponder: vi.fn<(id: string, data: unknown) => Promise<ActionJob>>(),
    settings: {
      fileBaseDir: settings.fileBaseDir,
      allowDestructive: settings.allowDestructive ?? false,
      maxFanout: settings.maxFanout ?? 10,
    },
  } as unknown as CortexClient;
}

// Helper to capture tool handlers from McpServer.tool() calls
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function captureTools(
  registerFn: (server: McpServer, client: CortexClient) => void,
  client: CortexClient,
): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const mockServer = {
    tool: vi.fn(
      (
        name: string,
        _desc: string,
        _schema: unknown,
        _annotations: unknown,
        handler: ToolHandler,
      ) => {
        tools.set(name, handler);
      },
    ),
  } as unknown as McpServer;

  registerFn(mockServer, client);
  return tools;
}

describe("Analyzer Tools", () => {
  let client: ReturnType<typeof createMockClient>;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    client = createMockClient() as unknown as ReturnType<typeof createMockClient>;
    tools = captureTools(registerAnalyzerTools, client as unknown as CortexClient);
  });

  describe("cortex_list_analyzers", () => {
    it("should list all analyzers", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      const handler = tools.get("cortex_list_analyzers")!;
      const result = await handler({});
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(3);
      expect(parsed[0].name).toBe("VirusTotal_GetReport");
    });

    it("should filter analyzers by dataType", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      const handler = tools.get("cortex_list_analyzers")!;
      const result = await handler({ dataType: "ip" });
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(2);
      expect(parsed.map((a: any) => a.name)).toContain("VirusTotal_GetReport");
      expect(parsed.map((a: any) => a.name)).toContain("AbuseIPDB");
    });

    it("should handle errors gracefully", async () => {
      (client as any).listAnalyzers.mockRejectedValue(
        new Error("Connection refused"),
      );

      const handler = tools.get("cortex_list_analyzers")!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection refused");
    });
  });

  describe("cortex_get_analyzer", () => {
    it("should get analyzer details", async () => {
      (client as any).getAnalyzer.mockResolvedValue(mockAnalyzers[0]);

      const handler = tools.get("cortex_get_analyzer")!;
      const result = await handler({ analyzerId: "VirusTotal_GetReport_3_1" });
      const parsed = parseData(result.content[0].text);

      expect(parsed.id).toBe("VirusTotal_GetReport_3_1");
      expect(parsed.name).toBe("VirusTotal_GetReport");
    });
  });

  describe("cortex_run_analyzer", () => {
    it("should submit observable for analysis", async () => {
      (client as any).runAnalyzer.mockResolvedValue(mockJob);

      const handler = tools.get("cortex_run_analyzer")!;
      const result = await handler({
        analyzerId: "VirusTotal_GetReport_3_1",
        dataType: "ip",
        data: "8.8.8.8",
        tlp: 2,
        pap: 2,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.jobId).toBe("job_abc123");
      expect(parsed.status).toBe("Waiting");
    });
  });

  describe("cortex_run_analyzer_by_name", () => {
    it("should find and run analyzer by name", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);
      (client as any).runAnalyzer.mockResolvedValue(mockJob);

      const handler = tools.get("cortex_run_analyzer_by_name")!;
      const result = await handler({
        analyzerName: "VirusTotal",
        dataType: "ip",
        data: "8.8.8.8",
        tlp: 2,
        pap: 2,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.analyzerUsed.name).toBe("VirusTotal_GetReport");
      expect(parsed.jobId).toBe("job_abc123");
    });

    it("should return error when no matching analyzer found", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      const handler = tools.get("cortex_run_analyzer_by_name")!;
      const result = await handler({
        analyzerName: "NonExistent",
        dataType: "ip",
        data: "8.8.8.8",
        tlp: 2,
        pap: 2,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No analyzer found");
    });
  });
});

describe("Job Tools", () => {
  let client: ReturnType<typeof createMockClient>;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    client = createMockClient() as unknown as ReturnType<typeof createMockClient>;
    tools = captureTools(registerJobTools, client as unknown as CortexClient);
  });

  describe("cortex_get_job", () => {
    it("should return job details", async () => {
      (client as any).getJob.mockResolvedValue(mockJob);

      const handler = tools.get("cortex_get_job")!;
      const result = await handler({ jobId: "job_abc123" });
      const parsed = parseData(result.content[0].text);

      expect(parsed.id).toBe("job_abc123");
      expect(parsed.status).toBe("Waiting");
    });
  });

  describe("cortex_get_job_report", () => {
    it("should return full report", async () => {
      (client as any).getJobReport.mockResolvedValue(mockJobReport);

      const handler = tools.get("cortex_get_job_report")!;
      const result = await handler({ jobId: "job_abc123" });
      const parsed = parseData(result.content[0].text);

      expect(parsed.report.summary.taxonomies).toHaveLength(1);
      expect(parsed.report.summary.taxonomies[0].level).toBe("malicious");
    });
  });

  describe("cortex_wait_and_get_report", () => {
    it("should return report with taxonomy summary", async () => {
      (client as any).waitAndGetReport.mockResolvedValue(mockJobReport);

      const handler = tools.get("cortex_wait_and_get_report")!;
      const result = await handler({ jobId: "job_abc123", timeout: 120 });
      const parsed = parseData(result.content[0].text);

      expect(parsed.status).toBe("Success");
      expect(parsed.taxonomies).toHaveLength(1);
      expect(parsed.taxonomies[0]).toContain("[malicious]");
    });
  });

  describe("cortex_list_jobs", () => {
    it("should list jobs with filters", async () => {
      const completedJob = { ...mockJob, status: "Success" as const };
      (client as any).searchJobs.mockResolvedValue([completedJob]);

      const handler = tools.get("cortex_list_jobs")!;
      const result = await handler({ dataType: "ip", limit: 10 });
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].dataType).toBe("ip");
    });
  });

  describe("cortex_get_job_artifacts", () => {
    it("should return extracted artifacts", async () => {
      (client as any).getJobArtifacts.mockResolvedValue(mockArtifacts);

      const handler = tools.get("cortex_get_job_artifacts")!;
      const result = await handler({ jobId: "job_abc123" });
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].data).toBe("malware.example.com");
      expect(parsed[1].data).toBe("192.0.2.100");
    });
  });
});

describe("Responder Tools", () => {
  let client: ReturnType<typeof createMockClient>;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    client = createMockClient({ allowDestructive: true }) as unknown as ReturnType<typeof createMockClient>;
    tools = captureTools(registerResponderTools, client as unknown as CortexClient);
  });

  describe("cortex_list_responders", () => {
    it("should list all responders", async () => {
      (client as any).listResponders.mockResolvedValue(mockResponders);

      const handler = tools.get("cortex_list_responders")!;
      const result = await handler({});
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("Mailer");
    });

    it("should filter by dataType", async () => {
      (client as any).listResponders.mockResolvedValue(mockResponders);

      const handler = tools.get("cortex_list_responders")!;
      const result = await handler({ dataType: "case" });
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(1);
    });

    it("should return empty when no match", async () => {
      (client as any).listResponders.mockResolvedValue(mockResponders);

      const handler = tools.get("cortex_list_responders")!;
      const result = await handler({ dataType: "ip" });
      const parsed = parseData(result.content[0].text);

      expect(parsed).toHaveLength(0);
    });
  });

  describe("cortex_run_responder", () => {
    it("should execute responder action", async () => {
      (client as any).runResponder.mockResolvedValue(mockActionJob);

      const handler = tools.get("cortex_run_responder")!;
      const result = await handler({
        responderId: "Mailer_1_0",
        objectType: "case_artifact",
        objectId: "artifact_456",
        confirm: true,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.actionJobId).toBe("action_789");
      expect(parsed.status).toBe("Success");
    });

    it("should refuse without confirm=true", async () => {
      (client as any).runResponder.mockResolvedValue(mockActionJob);

      const handler = tools.get("cortex_run_responder")!;
      const result = await handler({
        responderId: "Mailer_1_0",
        objectType: "case_artifact",
        objectId: "artifact_456",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("confirm=true");
      expect((client as any).runResponder).not.toHaveBeenCalled();
    });

    it("should refuse when destructive ops are disabled", async () => {
      const guardedClient = createMockClient({ allowDestructive: false });
      const guardedTools = captureTools(
        registerResponderTools,
        guardedClient as unknown as CortexClient,
      );
      (guardedClient as any).runResponder.mockResolvedValue(mockActionJob);

      const handler = guardedTools.get("cortex_run_responder")!;
      const result = await handler({
        responderId: "Mailer_1_0",
        objectType: "case_artifact",
        objectId: "artifact_456",
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("CORTEX_ALLOW_DESTRUCTIVE");
      expect((guardedClient as any).runResponder).not.toHaveBeenCalled();
    });
  });
});

describe("Bulk Tools", () => {
  let client: ReturnType<typeof createMockClient>;
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    client = createMockClient() as unknown as ReturnType<typeof createMockClient>;
    tools = captureTools(registerBulkTools, client as unknown as CortexClient);
  });

  describe("cortex_analyze_observable", () => {
    it("should run all applicable analyzers and aggregate results", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      // Two analyzers support IP: VirusTotal and AbuseIPDB
      let callCount = 0;
      (client as any).runAnalyzer.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          id: `job_${callCount}`,
          status: "Waiting",
        });
      });

      const vtReport: JobReport = {
        id: "job_1",
        status: "Success",
        analyzerName: "VirusTotal_GetReport",
        report: {
          summary: {
            taxonomies: [
              { level: "malicious", namespace: "VT", predicate: "GetReport", value: "5/87" },
            ],
          },
          success: true,
        },
      };

      const abuseReport: JobReport = {
        id: "job_2",
        status: "Success",
        analyzerName: "AbuseIPDB",
        report: {
          summary: {
            taxonomies: [
              { level: "suspicious", namespace: "AbuseIPDB", predicate: "Score", value: "75%" },
            ],
          },
          success: true,
        },
      };

      let waitCallCount = 0;
      (client as any).waitAndGetReport.mockImplementation(() => {
        waitCallCount++;
        return Promise.resolve(waitCallCount === 1 ? vtReport : abuseReport);
      });

      const handler = tools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "ip",
        data: "8.8.8.8",
        fanOut: true,
        tlp: 2,
        pap: 2,
        timeout: 60,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.analyzersRun).toBe(2);
      expect(parsed.summary.malicious).toBe(1);
      expect(parsed.summary.suspicious).toBe(1);
      expect(parsed.results).toHaveLength(2);
    });

    it("should refuse auto-fanout unless opted in", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      const handler = tools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "ip",
        data: "8.8.8.8",
        tlp: 2,
        pap: 2,
        timeout: 60,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.analyzersRun).toBe(0);
      expect(parsed.message).toContain("fanOut=true");
      expect((client as any).runAnalyzer).not.toHaveBeenCalled();
    });

    it("should honor an explicit analyzers allowlist", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);
      (client as any).runAnalyzer.mockResolvedValue({ id: "job_1", status: "Waiting" });
      (client as any).waitAndGetReport.mockResolvedValue({
        id: "job_1",
        status: "Success",
        analyzerName: "AbuseIPDB",
        report: { summary: { taxonomies: [] }, success: true },
      });

      const handler = tools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "ip",
        data: "8.8.8.8",
        analyzers: ["AbuseIPDB"],
        tlp: 2,
        pap: 2,
        timeout: 60,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.analyzersRun).toBe(1);
      // Only the allowlisted analyzer was submitted.
      expect((client as any).runAnalyzer).toHaveBeenCalledTimes(1);
      expect((client as any).runAnalyzer).toHaveBeenCalledWith(
        "AbuseIPDB_1_0",
        expect.anything(),
      );
    });

    it("should cap fanout at maxFanout and report skipped analyzers", async () => {
      const cappedClient = createMockClient({ maxFanout: 1 });
      const cappedTools = captureTools(
        registerBulkTools,
        cappedClient as unknown as CortexClient,
      );
      (cappedClient as any).listAnalyzers.mockResolvedValue(mockAnalyzers);
      (cappedClient as any).runAnalyzer.mockResolvedValue({ id: "job_1", status: "Waiting" });
      (cappedClient as any).waitAndGetReport.mockResolvedValue({
        id: "job_1",
        status: "Success",
        analyzerName: "VirusTotal_GetReport",
        report: { summary: { taxonomies: [] }, success: true },
      });

      const handler = cappedTools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "ip",
        data: "8.8.8.8",
        fanOut: true,
        tlp: 2,
        pap: 2,
        timeout: 60,
      });
      const parsed = parseData(result.content[0].text);

      // Two analyzers support IP, but the cap is 1.
      expect(parsed.analyzersRun).toBe(1);
      expect(parsed.analyzersSkippedByCap).toBe(1);
      expect((cappedClient as any).runAnalyzer).toHaveBeenCalledTimes(1);
    });

    it("should attribute submission errors to the correct analyzer (no off-by-alignment)", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      // First applicable analyzer (VirusTotal_GetReport) FAILS to submit, the
      // second (AbuseIPDB) succeeds. The old code mapped rejected results onto
      // applicable[i] by filtered index, misattributing the failing name.
      (client as any).runAnalyzer.mockImplementation((id: string) => {
        if (id === "VirusTotal_GetReport_3_1") {
          return Promise.reject(new Error("VT submit failed"));
        }
        return Promise.resolve({ id: "job_abuse", status: "Waiting" });
      });
      (client as any).waitAndGetReport.mockResolvedValue({
        id: "job_abuse",
        status: "Success",
        analyzerName: "AbuseIPDB",
        report: { summary: { taxonomies: [] }, success: true },
      });

      const handler = tools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "ip",
        data: "8.8.8.8",
        fanOut: true,
        tlp: 2,
        pap: 2,
        timeout: 60,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.analyzersFailed).toBe(1);
      expect(parsed.submissionErrors).toHaveLength(1);
      // The failure must be attributed to VirusTotal_GetReport, not AbuseIPDB.
      expect(parsed.submissionErrors[0].analyzer).toBe("VirusTotal_GetReport");
      expect(parsed.submissionErrors[0].error).toContain("VT submit failed");
    });

    it("should return message when no analyzers support the data type", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      const handler = tools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "registry",
        data: "HKLM\\Software\\Malware",
        tlp: 2,
        pap: 2,
        timeout: 60,
      });

      expect(result.content[0].text).toContain("No enabled analyzers support data type");
    });

    it("should handle partial failures gracefully", async () => {
      (client as any).listAnalyzers.mockResolvedValue(mockAnalyzers);

      let callCount = 0;
      (client as any).runAnalyzer.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ id: "job_1", status: "Waiting" });
        }
        return Promise.reject(new Error("Analyzer rate limited"));
      });

      (client as any).waitAndGetReport.mockResolvedValue({
        id: "job_1",
        status: "Success",
        analyzerName: "VirusTotal_GetReport",
        report: {
          summary: {
            taxonomies: [
              { level: "safe", namespace: "VT", predicate: "GetReport", value: "0/87" },
            ],
          },
          success: true,
        },
      });

      const handler = tools.get("cortex_analyze_observable")!;
      const result = await handler({
        dataType: "ip",
        data: "8.8.8.8",
        fanOut: true,
        tlp: 2,
        pap: 2,
        timeout: 60,
      });
      const parsed = parseData(result.content[0].text);

      expect(parsed.analyzersRun).toBe(1);
      expect(parsed.analyzersFailed).toBe(1);
      expect(parsed.submissionErrors).toHaveLength(1);
    });
  });
});

describe("cortex_run_analyzer_file path containment", () => {
  let baseDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "cortex-base-"));
    outsideDir = await mkdtemp(join(tmpdir(), "cortex-outside-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  function fileClient(settings: { fileBaseDir?: string }) {
    return {
      runAnalyzerWithFile: vi.fn(async () => mockJob),
      settings: {
        fileBaseDir: settings.fileBaseDir,
        allowDestructive: false,
        maxFanout: 10,
      },
    } as unknown as CortexClient;
  }

  it("reads a file inside the configured base dir", async () => {
    const inside = join(baseDir, "sample.bin");
    await writeFile(inside, "hello");
    const client = fileClient({ fileBaseDir: baseDir });
    const tools = captureTools(registerAnalyzerTools, client);

    const handler = tools.get("cortex_run_analyzer_file")!;
    const result = await handler({
      analyzerId: "File_Info_8_0",
      filePath: inside,
      contentType: "application/octet-stream",
      tlp: 2,
      pap: 2,
    });

    expect(result.isError).toBeUndefined();
    expect((client as any).runAnalyzerWithFile).toHaveBeenCalledTimes(1);
  });

  it("refuses an absolute path outside the base dir", async () => {
    const outside = join(outsideDir, "secret.txt");
    await writeFile(outside, "TOP SECRET");
    const client = fileClient({ fileBaseDir: baseDir });
    const tools = captureTools(registerAnalyzerTools, client);

    const handler = tools.get("cortex_run_analyzer_file")!;
    const result = await handler({
      analyzerId: "File_Info_8_0",
      filePath: outside,
      contentType: "application/octet-stream",
      tlp: 2,
      pap: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("outside the allowed base directory");
    expect((client as any).runAnalyzerWithFile).not.toHaveBeenCalled();
  });

  it("refuses traversal sequences that escape the base dir", async () => {
    const outside = join(outsideDir, "secret.txt");
    await writeFile(outside, "TOP SECRET");
    const client = fileClient({ fileBaseDir: baseDir });
    const tools = captureTools(registerAnalyzerTools, client);

    const handler = tools.get("cortex_run_analyzer_file")!;
    const result = await handler({
      analyzerId: "File_Info_8_0",
      // Relative traversal from baseDir into the sibling outside dir.
      filePath: join("..", outside),
      contentType: "application/octet-stream",
      tlp: 2,
      pap: 2,
    });

    expect(result.isError).toBe(true);
    expect((client as any).runAnalyzerWithFile).not.toHaveBeenCalled();
  });

  it("refuses filePath reads entirely when no base dir is configured", async () => {
    const inside = join(baseDir, "sample.bin");
    await writeFile(inside, "hello");
    const client = fileClient({ fileBaseDir: undefined });
    const tools = captureTools(registerAnalyzerTools, client);

    const handler = tools.get("cortex_run_analyzer_file")!;
    const result = await handler({
      analyzerId: "File_Info_8_0",
      filePath: inside,
      contentType: "application/octet-stream",
      tlp: 2,
      pap: 2,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CORTEX_FILE_BASE_DIR");
    expect((client as any).runAnalyzerWithFile).not.toHaveBeenCalled();
  });

  it("still accepts base64 content when base dir is unset", async () => {
    const client = fileClient({ fileBaseDir: undefined });
    const tools = captureTools(registerAnalyzerTools, client);

    const handler = tools.get("cortex_run_analyzer_file")!;
    const result = await handler({
      analyzerId: "File_Info_8_0",
      fileBase64: Buffer.from("hello").toString("base64"),
      filename: "sample.bin",
      contentType: "application/octet-stream",
      tlp: 2,
      pap: 2,
    });

    expect(result.isError).toBeUndefined();
    expect((client as any).runAnalyzerWithFile).toHaveBeenCalledTimes(1);
  });
});
