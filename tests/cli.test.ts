import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";

describe("cortexctrl", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const stdout = () => vi.mocked(console.log).mock.lastCall?.[0];
  const stderr = () => vi.mocked(console.error).mock.lastCall?.[0];
  const status = {
    versions: { Cortex: "3.1.8", Elastic4Play: "1.0.0", Play: "2.8.22" },
    config: { authType: ["local"], capabilities: ["analyzers"] },
  };
  const job = {
    id: "job_123", status: "Waiting", analyzerId: "test_analyzer",
    analyzerName: "Test", dataType: "ip", data: "8.8.8.8",
  };

  beforeEach(() => {
    vi.stubEnv("CORTEX_URL", "http://127.0.0.1:9001");
    vi.stubEnv("CORTEX_API_KEY", "fake-cli-credential");
    vi.stubEnv("CORTEX_SUPERADMIN_KEY", undefined);
    vi.stubEnv("CREDENTIALS_DIRECTORY", undefined);
    vi.stubEnv("CORTEX_MODE", undefined);
    vi.stubEnv("CORTEX_ALLOW_PRIVATE_TARGETS", "false");
    vi.stubEnv("CORTEX_ALLOW_INSECURE_REMOTE_HTTP", "false");
    vi.stubEnv("CORTEX_VERIFY_SSL", "true");
    vi.stubEnv("CORTEX_TIMEOUT", "30");
    vi.stubEnv("CORTEX_MAX_FANOUT", "10");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockReset().mockRejectedValue(new Error("Unexpected request"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prints help and version without reading Cortex configuration", async () => {
    vi.stubEnv("CORTEX_URL", undefined);
    expect(await run([])).toBe(0);
    expect(stdout()).toContain("alias: cortexctl");
    expect(await run(["--version"])).toBe(0);
    expect(stdout()).toBe("1.3.4");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["responders", "run", "example"],
    ["analyzers", "run", "example", "--file", "sample.bin"],
    ["analyzers", "run", "example", "--data-type", "ip", "--data", "8.8.8.8", "--pap", "4"],
    ["jobs", "delete", "job_123", "--confirm", "--destructive"],
    ["jobs", "get", ".."],
  ])("rejects unsupported or invalid arguments %j before any request", async (...args) => {
    expect(await run(args)).toBe(2);
    expect(stderr()).toContain("Run cortexctrl help");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints the status JSON contract using the hardened transport", async () => {
    fetchMock.mockResolvedValueOnce(Response.json(status));

    expect(await run(["--json", "status"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      healthy: true,
      version: "3.1.8",
      versions: status.versions,
      auth_types: ["local"],
      capabilities: ["analyzers"],
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:9001/api/status",
      expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer fake-cli-credential" } }));
  });

  it("filters the analyzer inventory and prints a concise summary", async () => {
    fetchMock.mockResolvedValueOnce(Response.json([
      { id: "net", name: "Net", version: "1.0", description: "Network", dataTypeList: ["ip"] },
      { id: "files", name: "Files", version: "1.0", description: "File analysis", dataTypeList: ["hash"] },
    ]));

    expect(await run(["analyzers", "list", "--data-type", "ip"])).toBe(0);
    expect(stdout()).toBe("analyzers count=1 data_type=ip\nid=net name=Net version=1.0 data_types=ip");
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9001/api/analyzer");
  });

  it("gets a single job and omits fields outside the published summary", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...job, createdAt: 0, report: { details: true } }));

    expect(await run(["jobs", "get", "job_123", "--json"])).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      id: "job_123", status: "Waiting", analyzer_id: "test_analyzer",
      analyzer_name: "Test", data_type: "ip", data: "8.8.8.8",
      created_at: "1970-01-01T00:00:00.000Z",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:9001/api/job/job_123");
  });

  it("keeps the read-only default and requires the existing private target opt-in", async () => {
    const args = ["analyzers", "run", "test_analyzer", "--data-type", "ip", "--data", "127.0.0.1"];
    expect(await run(args)).toBe(1);
    expect(JSON.parse(stderr()).error).toContain("CORTEX_MODE=write");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("CORTEX_MODE", "write");
    expect(await run(args)).toBe(1);
    expect(JSON.parse(stderr()).error).toContain("CORTEX_ALLOW_PRIVATE_TARGETS=true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits one analyzer job through the client when writes are enabled", async () => {
    vi.stubEnv("CORTEX_MODE", "write");
    fetchMock.mockResolvedValueOnce(Response.json(job));

    expect(await run(["analyzers", "run", "test_analyzer", "--data-type", "ip", "--data", "8.8.8.8"])).toBe(0);
    expect(stdout()).toBe("job_id=job_123 status=Waiting analyzer_id=test_analyzer analyzer=Test data_type=ip");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:9001/api/analyzer/test_analyzer/run",
      expect.objectContaining({
        method: "POST", redirect: "error",
        body: JSON.stringify({ data: "8.8.8.8", dataType: "ip", tlp: 2, pap: 2 }),
      }));
  });

  it("reports configuration failures without fetching", async () => {
    vi.stubEnv("CORTEX_URL", "http://cortex.example.invalid");
    expect(await run(["status"])).toBe(1);
    expect(JSON.parse(stderr()).error).toContain("CORTEX_URL requires HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts credentials in errors and returns a failure exit code", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Request failed for fake-cli-credential (Bearer another-token)"));

    expect(await run(["status"])).toBe(1);
    expect(JSON.parse(stderr()).error).toBe("Request failed for [REDACTED] (Bearer [REDACTED])");
  });
});
