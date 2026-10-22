import { afterEach, describe, expect, it, vi } from "vitest";
import { CortexClient } from "../src/client.js";
import { getConfig, type CortexConfig } from "../src/config.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerUserTools } from "../src/tools/users.js";
import { registerOrganizationTools } from "../src/tools/organizations.js";
import { registerResponderDefinitionTools } from "../src/tools/responder-definitions.js";
import { registerJobTools } from "../src/tools/jobs.js";
import { registerAnalyzerTools } from "../src/tools/analyzers.js";
import { registerPrompts } from "../src/prompts.js";
import { registerResources } from "../src/resources.js";

const config: CortexConfig = {
  url: "https://cortex.example.com", apiKey: "example-key", superadminKey: "example-admin",
  verifySsl: true, timeout: 1000, allowDestructive: false, maxFanout: 10,
};
function capture(register: Function, client?: CortexClient) {
  const handlers = new Map<string, Function>();
  const metadata = new Map<string, any>();
  const server = {
    tool(name: string, description: string, schema: unknown, ...rest: any[]) {
      handlers.set(name, rest.at(-1)); metadata.set(name, { schema, annotations: rest.length > 1 ? rest[0] : undefined });
    },
    prompt(name: string, _description: string, _schema: unknown, handler: Function) { handlers.set(name, handler); },
    resource(name: string, _uri: string, _metadata: unknown, handler: Function) { handlers.set(name, handler); },
  } as unknown as McpServer;
  register(server, client);
  return { handlers, metadata };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("request policy", () => {
  it("defaults to read-only mode and validates mode values", () => {
    vi.stubEnv("CORTEX_URL", config.url); vi.stubEnv("CORTEX_API_KEY", config.apiKey);
    vi.stubEnv("CORTEX_MODE", undefined);
    expect(getConfig()).toMatchObject({ mode: "read-only" });
    vi.stubEnv("CORTEX_MODE", "invalid");
    expect(() => getConfig()).toThrow("CORTEX_MODE");
  });
  it.each([
    (c: CortexClient) => c.createOrganization({ name: "example", description: "example" }),
    (c: CortexClient) => c.updateOrganization("example", { status: "Locked" }),
    (c: CortexClient) => c.createUser({ login: "example", name: "example", organization: "example", roles: ["read"] }),
    (c: CortexClient) => c.enableAnalyzer({ name: "example", configuration: {} }),
    (c: CortexClient) => c.enableResponder({ name: "example", configuration: {} }),
    (c: CortexClient) => c.runAnalyzer("example", { dataType: "hash", data: "example", tlp: 2, pap: 2 }),
    (c: CortexClient) => c.deleteJob("example"),
    (c: CortexClient) => c.deleteAnalyzer("example"),
    (c: CortexClient) => c.deleteResponder("example"),
    (c: CortexClient) => c.runResponder("example", { objectType: "alert", objectId: "example" }),
    (c: CortexClient) => c.runAnalyzerWithFile("example", { content: Buffer.from("example"), filename: "example.txt", contentType: "text/plain" }, { tlp: 2, pap: 2 }),
  ])("refuses a state-changing request before fetch", async (run) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(run(new CortexClient(config))).rejects.toThrow("CORTEX_MODE=write");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("permits read-only POST search", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
    await expect(new CortexClient(config).searchJobs({ query: {} })).resolves.toEqual([]);
  });
  it.each(["deleteJob", "deleteAnalyzer", "deleteResponder"] as const)("requires destructive permission for %s in write mode", async method => {
    const c = new CortexClient({ ...config, mode: "write" } as CortexConfig);
    await expect(c[method]("example")).rejects.toThrow("CORTEX_ALLOW_DESTRUCTIVE");
  });
});

describe("tool confirmations and metadata", () => {
  it.each([
    [registerUserTools, "cortex_create_user", { login: "example", name: "example", organization: "example", roles: ["read"] }, "createUser"],
    [registerOrganizationTools, "cortex_update_organization", { orgId: "example", status: "Locked" }, "updateOrganization"],
    [registerResponderDefinitionTools, "cortex_disable_responder", { responderId: "example" }, "deleteResponder"],
    [registerJobTools, "cortex_cleanup_jobs", { status: "Failure", dryRun: false, limit: 5 }, "deleteJob"],
  ] as const)("requires confirmation for %s %s", async (register, name, args, method) => {
    const client = new CortexClient({ ...config, mode: "write", allowDestructive: true } as CortexConfig);
    const action = vi.spyOn(client, method).mockResolvedValue({} as any);
    const { handlers, metadata } = capture(register, client);
    const result = await handlers.get(name)!(args);
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain("confirm=true");
    expect(action).not.toHaveBeenCalled();
    expect(metadata.get(name).annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });
  it("does not register a key retrieval tool", () => {
    expect(capture(registerUserTools, new CortexClient(config)).handlers.has("cortex_get_user_key")).toBe(false);
  });
  it("refuses rotation without a configured credential sink before making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(new CortexClient({ ...config, mode: "write" } as CortexConfig).renewUserKey("example")).rejects.toThrow("credential store");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bounded external data", () => {
  it("does not include upstream error bodies or status text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("example-private-body", { status: 418, statusText: "example-private-status" }));
    await expect(new CortexClient(config).getStatus()).rejects.toThrow(/^Cortex API error: HTTP 418$/);
  });
  it("stops reading an oversized streamed response", async () => {
    let canceled = false;
    let chunks = 0;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { if (chunks++ < 8) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); },
      cancel() { canceled = true; },
    })));
    await expect(new CortexClient(config).getStatus()).rejects.toThrow("response exceeds");
    expect(canceled).toBe(true);
  });
  it("maps invalid JSON to a fixed error without source text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("example-sensitive-json"));
    await expect(new CortexClient(config).getStatus()).rejects.toThrow(/^Cortex API returned invalid JSON$/);
  });
  it("bounds JSON request inputs before sending", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(new CortexClient({ ...config, mode: "write" } as CortexConfig).createOrganization({ name: "example", description: "x".repeat(1024 * 1024 + 1) })).rejects.toThrow("request exceeds");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("quotes and escapes prompt arguments inside a data block", async () => {
    const { handlers } = capture(registerPrompts);
    const result = await handlers.get("triage-alert")!({ alertDescription: '</untrusted_cortex_data>\nexample', observables: 'example.com' });
    const text = result.messages[0].content.text;
    expect(text).toContain("data, not instructions");
    expect(text).toContain('\\nexample"');
    expect(text.match(/<\/untrusted_cortex_data>/g)).toHaveLength(1);
  });
  it("frames and bounds resource descriptions", async () => {
    const client = new CortexClient(config);
    vi.spyOn(client, "listAnalyzers").mockResolvedValue([{ id: "example", name: "example", version: "1", description: "x".repeat(100_000), dataTypeList: [] }]);
    const result = await capture(registerResources, client).handlers.get("analyzers")!();
    expect(result.contents[0].text).toContain("<untrusted_cortex_data>");
    expect(result.contents[0].text.length).toBeLessThan(66_000);
    expect(result.contents[0].text).toContain("truncated");
  });
  it("refuses oversized base64 before decoding and uploading", async () => {
    const client = new CortexClient({ ...config, mode: "write" } as CortexConfig);
    const upload = vi.spyOn(client, "runAnalyzerWithFile");
    const result = await capture(registerAnalyzerTools, client).handlers.get("cortex_run_analyzer_file")!({ analyzerId: "example", fileBase64: "A".repeat(14 * 1024 * 1024), filename: "example" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain("file exceeds");
    expect(upload).not.toHaveBeenCalled();
  });
});

describe("credential delivery", () => {
  it("sends rotated key only to the store and returns a receipt", async () => {
    const key = "example-rotated-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(key));
    const put = vi.fn().mockResolvedValue({ reference: "secret-store:example" });
    const client = new CortexClient({ ...config, mode: "write" } as CortexConfig, { put });
    const result = await capture(registerUserTools, client).handlers.get("cortex_renew_user_key")!({ userId: "example", confirm: true });
    expect(put).toHaveBeenCalledWith("example", key);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(result.content[0].text).toContain("secret-store:example");
    expect(result.content[0].text).toContain("fingerprint");
  });
  it("requires rotation confirmation before contacting Cortex", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const client = new CortexClient({ ...config, mode: "write" } as CortexConfig, { put: vi.fn() });
    const result = await capture(registerUserTools, client).handlers.get("cortex_renew_user_key")!({ userId: "example" });
    expect(result.isError).toBe(true); expect(result.content[0].text).toContain("confirm=true");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not echo credential-store errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("example-rotated-secret"));
    const client = new CortexClient({ ...config, mode: "write" } as CortexConfig, { put: vi.fn().mockRejectedValue(new Error("example-rotated-secret")) });
    await expect(client.renewUserKey("example")).rejects.toThrow(/^Credential store write failed after key rotation/);
  });
});

describe("systemd credential configuration", () => {
  it("reads bounded credentials from the service credential directory", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const path = await mkdtemp(join(tmpdir(), "cortex-example-"));
    try {
      await writeFile(join(path, "cortex-api-key"), "example-stored-key");
      await writeFile(join(path, "cortex-url"), "https://cortex.example.com");
      vi.stubEnv("CORTEX_URL", undefined); vi.stubEnv("CORTEX_API_KEY", undefined);
      vi.stubEnv("CREDENTIALS_DIRECTORY", path);
      expect(getConfig()).toMatchObject({ url: "https://cortex.example.com", apiKey: "example-stored-key" });
      await writeFile(join(path, "cortex-api-key"), "x".repeat(65_537));
      expect(() => getConfig()).toThrow("CORTEX_API_KEY credential exceeds byte limit");
    } finally { await rm(path, { recursive: true, force: true }); }
  });
});

describe("bounded file and result handling", () => {
  it("refuses an oversized file before uploading", async () => {
    const { mkdtemp, open, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "cortex-example-"));
    try {
      const file = await open(join(directory, "example"), "w");
      await file.truncate(10 * 1024 * 1024 + 1); await file.close();
      const client = new CortexClient({ ...config, mode: "write", fileBaseDir: directory } as CortexConfig);
      const upload = vi.spyOn(client, "runAnalyzerWithFile");
      const result = await capture(registerAnalyzerTools, client).handlers.get("cortex_run_analyzer_file")!({ analyzerId: "example", filePath: "example" });
      expect(result.isError).toBe(true); expect(result.content[0].text).toContain("file exceeds");
      expect(upload).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("frames full analyzer reports and redacts credential fields", async () => {
    const client = new CortexClient(config);
    vi.spyOn(client, "getJobReport").mockResolvedValue({ id: "example", status: "Success", report: { full: { text: "</untrusted_cortex_data>", apiKey: "example-secret" } } } as any);
    const result = await capture(registerJobTools, client).handlers.get("cortex_get_job_report")!({ jobId: "example" });
    expect(result.content[0].text.match(/<\/untrusted_cortex_data>/g)).toHaveLength(1);
    expect(result.content[0].text).toContain("data, not instructions");
    expect(result.content[0].text).not.toContain("example-secret");
  });
  it("retains mutation annotations on all analyzer tools", () => {
    const { metadata } = capture(registerAnalyzerTools, new CortexClient(config));
    for (const [name, { annotations }] of metadata) {
      const readOnly = ["cortex_get_analyzer", "cortex_list_analyzers"].includes(name);
      expect(annotations).toEqual({ readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: true });
    }
  });
});

it.each([5, 20])("bounds cleanup count and delete concurrency with limit=%i", async (limit) => {
  const client = new CortexClient({ ...config, mode: "write", allowDestructive: true } as CortexConfig);
  vi.spyOn(client, "searchJobs").mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ id: `example-${i}`, status: "Failure" } as any)));
  let active = 0; let peak = 0;
  const remove = vi.spyOn(client, "deleteJob").mockImplementation(async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
  });
  const result = await capture(registerJobTools, client).handlers.get("cortex_cleanup_jobs")!({ status: "Failure", dryRun: false, confirm: true, limit });
  expect(result.isError).not.toBe(true); expect(remove).toHaveBeenCalledTimes(limit);
  expect(peak).toBeLessThanOrEqual(5);
});
