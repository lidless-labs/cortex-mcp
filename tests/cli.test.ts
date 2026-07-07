import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HELP, parseArgs, run, type CortexCtrlDeps } from "../src/cli.js";
import {
  CliGateError,
  requireDestructiveCliGate,
  requireResponderCliGate,
} from "../src/cli-safety.js";
import type { CortexClient } from "../src/client.js";
import type { CortexConfig } from "../src/config.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { bin?: Record<string, string> };

const mockConfig: CortexConfig = {
  url: "https://cortex.example.com",
  apiKey: "test-api-key-123",
  superadminKey: "super-secret-456",
  verifySsl: true,
  timeout: 30_000,
  allowDestructive: false,
  maxFanout: 10,
};

function capture(client: Partial<CortexClient>, deps: Partial<CortexCtrlDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const resolvedDeps: Partial<CortexCtrlDeps> = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    getConfig: () => mockConfig,
    makeClient: () => client as CortexClient,
    serve: vi.fn().mockResolvedValue(undefined),
    ...deps,
  };
  return { out, err, deps: resolvedDeps };
}

describe("cortexctrl CLI", () => {
  it("documents cortexctrl as the primary CLI and keeps compatibility bins", () => {
    expect(HELP).toContain("cortexctrl - Cortex observable-analysis control CLI");
    expect(HELP).toContain("alias: cortexctl");
    expect(packageJson.bin).toMatchObject({
      cortexctrl: "dist/cli.js",
      cortexctl: "dist/cli.js",
      "cortex-mcp": "dist/mcp-bin.js",
    });
  });

  it("parses the first-slice commands", () => {
    expect(parseArgs(["status", "--json"])).toEqual({ kind: "status", json: true });
    expect(parseArgs(["analyzers", "list", "--data-type", "ip"])).toEqual({
      kind: "analyzers list",
      json: false,
      dataType: "ip",
    });
    expect(parseArgs(["analyzers", "run", "AbuseIPDB_1_0", "--data-type", "ip", "--data", "8.8.8.8"])).toMatchObject({
      kind: "analyzers run",
      analyzerId: "AbuseIPDB_1_0",
      dataType: "ip",
      data: "8.8.8.8",
      tlp: 2,
      pap: 2,
    });
    expect(parseArgs(["jobs", "get", "job_123"])).toEqual({
      kind: "jobs get",
      json: false,
      jobId: "job_123",
    });
  });

  it("runs cortexctrl status --json", async () => {
    const client = {
      getStatus: vi.fn().mockResolvedValue({
        versions: {
          Cortex: "3.1.8",
          Elastic4Play: "1.0.0",
          Play: "2.8.22",
        },
        config: {
          authType: ["local"],
          capabilities: ["analyzers", "responders"],
        },
      }),
    };
    const { out, deps } = capture(client);

    await expect(run(["status", "--json"], deps)).resolves.toBe(0);

    const data = JSON.parse(out[0]) as Record<string, any>;
    expect(data.version).toBe("3.1.8");
    expect(data.capabilities).toEqual(["analyzers", "responders"]);
    expect(client.getStatus).toHaveBeenCalledTimes(1);
  });

  it("runs cortexctrl analyzers list --data-type ip", async () => {
    const client = {
      listAnalyzers: vi.fn().mockResolvedValue([
        {
          id: "AbuseIPDB_1_0",
          name: "AbuseIPDB",
          version: "1.0",
          description: "Check IP reputation",
          dataTypeList: ["ip"],
        },
        {
          id: "URLhaus_2_0",
          name: "URLhaus",
          version: "2.0",
          description: "Check URL reputation",
          dataTypeList: ["url", "domain"],
        },
      ]),
    };
    const { out, deps } = capture(client);

    await expect(run(["analyzers", "list", "--data-type", "ip"], deps)).resolves.toBe(0);

    expect(out.join("\n")).toContain("analyzers count=1 data_type=ip");
    expect(out.join("\n")).toContain("id=AbuseIPDB_1_0");
    expect(out.join("\n")).not.toContain("URLhaus");
  });

  it("runs cortexctrl analyzers run", async () => {
    const client = {
      runAnalyzer: vi.fn().mockResolvedValue({
        id: "job_123",
        analyzerId: "AbuseIPDB_1_0",
        analyzerName: "AbuseIPDB",
        status: "Waiting",
        dataType: "ip",
        data: "8.8.8.8",
      }),
    };
    const { out, deps } = capture(client);

    await expect(
      run(["analyzers", "run", "AbuseIPDB_1_0", "--data-type", "ip", "--data", "8.8.8.8"], deps),
    ).resolves.toBe(0);

    expect(client.runAnalyzer).toHaveBeenCalledWith("AbuseIPDB_1_0", {
      data: "8.8.8.8",
      dataType: "ip",
      tlp: 2,
      pap: 2,
      message: undefined,
    });
    expect(out.join("\n")).toContain("job_id=job_123");
    expect(out.join("\n")).toContain("status=Waiting");
  });

  it("runs cortexctrl jobs get", async () => {
    const client = {
      getJob: vi.fn().mockResolvedValue({
        id: "job_123",
        analyzerName: "AbuseIPDB",
        status: "Success",
        dataType: "ip",
        data: "8.8.8.8",
      }),
    };
    const { out, deps } = capture(client);

    await expect(run(["jobs", "get", "job_123"], deps)).resolves.toBe(0);

    expect(client.getJob).toHaveBeenCalledWith("job_123");
    expect(out.join("\n")).toContain("id=job_123");
    expect(out.join("\n")).toContain("status=Success");
  });

  it("redacts API keys from CLI errors", async () => {
    const client = {
      getJob: vi.fn().mockRejectedValue(new Error("boom test-api-key-123 Bearer abc.def.ghi")),
    };
    const { err, deps } = capture(client);

    await expect(run(["jobs", "get", "job_123"], deps)).resolves.toBe(1);

    expect(err.join("\n")).not.toContain("test-api-key-123");
    expect(err.join("\n")).not.toContain("abc.def.ghi");
    expect(err.join("\n")).toContain("[REDACTED]");
  });

  it("delegates cortexctrl mcp to the MCP server", async () => {
    const serve = vi.fn().mockResolvedValue(undefined);
    const { deps } = capture({}, { serve });

    await expect(run(["mcp"], deps)).resolves.toBe(0);

    expect(serve).toHaveBeenCalledTimes(1);
  });
});

describe("cortexctrl safety gates", () => {
  it("requires env opt-in plus flags for destructive CLI commands", () => {
    expect(() =>
      requireDestructiveCliGate({
        commandName: "cortex jobs delete",
        env: {},
        confirm: true,
        destructive: true,
      }),
    ).toThrow(CliGateError);

    expect(() =>
      requireDestructiveCliGate({
        commandName: "cortex jobs delete",
        env: { CORTEX_ALLOW_DESTRUCTIVE: "1" },
        confirm: true,
        destructive: false,
      }),
    ).toThrow("--confirm and --destructive");

    expect(() =>
      requireDestructiveCliGate({
        commandName: "cortex jobs delete",
        env: { CORTEX_ALLOW_DESTRUCTIVE: "1" },
        confirm: true,
        destructive: true,
      }),
    ).not.toThrow();
  });

  it("uses the same destructive gate for responder CLI commands", () => {
    expect(() =>
      requireResponderCliGate({
        env: {},
        confirm: true,
        destructive: true,
      }),
    ).toThrow(CliGateError);

    expect(() =>
      requireResponderCliGate({
        env: { CORTEX_ALLOW_DESTRUCTIVE: "true" },
        confirm: true,
        destructive: true,
      }),
    ).not.toThrow();
  });
});
