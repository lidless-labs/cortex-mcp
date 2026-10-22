import { createHash } from "node:crypto";
import { MAX_REQUEST_BYTES, MAX_FILE_BYTES, readResponse, parseResponse, httpError } from "./safety.js";
import { validateObservableTarget } from "./targets.js";
import { Agent } from "undici";
import type { CortexConfig } from "./config.js";
import type {
  Analyzer,
  AnalyzerDefinition,
  Artifact,
  Job,
  JobReport,
  JobSearchQuery,
  Responder,
  ResponderDefinition,
  ActionJob,
  RunAnalyzerRequest,
  RunResponderRequest,
  EnableWorkerRequest,
  CortexStatus,
  Organization,
  CortexUser,
} from "./types.js";

/**
 * Transport margin added on top of a waitreport's `atMost` duration, so Cortex
 * can answer at the end of its wait window before the client gives up.
 */
const WAIT_REPORT_MARGIN_MS = 10_000;

/** Per-request overrides for the shared request path. */
interface RequestOverrides {
  /** Abort timer for this request in ms. Defaults to the configured timeout. */
  timeoutMs?: number;
  /** undici dispatcher for this request. Defaults to the scoped dispatcher. */
  dispatcher?: Agent;
  readOnlySearch?: boolean;
}

export interface CredentialStore {
  /** Persist directly to an operator-approved store without logging key material. */
  put(userId: string, key: string): Promise<{ reference: string }>;
}

export class CortexClient {
  private baseUrl: string;
  private timeout: number;
  /**
   * Scoped undici dispatcher used only for Cortex requests. When SSL
   * verification is disabled, this Agent relaxes cert checks for THIS client's
   * traffic only, instead of flipping the process-global
   * NODE_TLS_REJECT_UNAUTHORIZED, which would weaken TLS for the whole process.
   */
  private dispatcher?: Agent;
  /**
   * Dispatcher for waitreport calls, created on first use and reused so
   * concurrent waits share one connection pool. undici's default 300 s
   * headersTimeout and bodyTimeout would cut off a wait of 300 s or more
   * before Cortex answers, so both are disabled and the per-request abort
   * timer bounds the call instead.
   */
  private waitReportAgent?: Agent;

  constructor(private config: CortexConfig, private credentialStore?: CredentialStore) {
    this.baseUrl = `${config.url}/api`;
    this.timeout = config.timeout;
    if (!config.verifySsl) {
      this.dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  /**
   * Extra fetch init carrying the scoped dispatcher (when present). undici's
   * `dispatcher` is not in the lib.dom RequestInit type, so it is attached via
   * a loosely-typed object.
   */
  private get fetchInit(): Record<string, unknown> {
    return this.dispatcher ? { dispatcher: this.dispatcher } : {};
  }

  private get waitReportDispatcher(): Agent {
    this.waitReportAgent ??= new Agent({
      headersTimeout: 0,
      bodyTimeout: 0,
      ...(this.config.verifySsl
        ? {}
        : { connect: { rejectUnauthorized: false } }),
    });
    return this.waitReportAgent;
  }

  /** Read-only view of safety-relevant configuration for tool gating. */
  get settings(): {
    fileBaseDir?: string;
    allowDestructive: boolean;
    maxFanout: number;
    mode: "read-only" | "write";
  } {
    return {
      fileBaseDir: this.config.fileBaseDir,
      allowDestructive: this.config.allowDestructive,
      maxFanout: this.config.maxFanout,
      mode: this.config.mode ?? "read-only",
    };
  }

  private assertRequestAllowed(method: string, path: string, readOnlySearch = false): void {
    if (["GET", "HEAD"].includes(method) || (readOnlySearch && method === "POST" && path.split("?")[0] === "/job/_search")) return;
    if (this.config.mode !== "write") throw new Error("State-changing requests require CORTEX_MODE=write");
    if ((method === "DELETE" || /^\/responder\/[^/]+\/run$/.test(path)) && !this.config.allowDestructive) {
      throw new Error("This operation requires CORTEX_ALLOW_DESTRUCTIVE=1");
    }
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    useSuperadmin = false,
    overrides: RequestOverrides = {},
  ): Promise<T> {
    this.assertRequestAllowed(options.method ?? "GET", path, overrides.readOnlySearch);
    if (typeof options.body === "string" && Buffer.byteLength(options.body) > MAX_REQUEST_BYTES) {
      throw new Error("Cortex API request exceeds byte limit");
    }
    const url = `${this.baseUrl}${path}`;
    const timeoutMs = overrides.timeoutMs ?? this.timeout;
    const dispatcher = overrides.dispatcher ?? this.dispatcher;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const authKey = useSuperadmin
      ? (this.config.superadminKey ?? this.config.apiKey)
      : this.config.apiKey;

    // Cortex (Play Framework) rejects Content-Type: application/json on GET
    // requests with no body. Only include it when there's a request body.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${authKey}`,
    };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(url, {
        ...options,
        redirect: "error",
        ...(dispatcher ? { dispatcher } : {}),
        headers: { ...headers, ...(options.headers as Record<string, string>) },
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status);
      }

      // Some DELETE endpoints return empty body
      const text = await readResponse(response);
      if (!text) return undefined as T;
      return parseResponse<T>(text);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Cortex API timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Raw text request for endpoints that return plain text (e.g. key renewal)
  private async requestText(
    path: string,
    options: RequestInit = {},
    useSuperadmin = false,
  ): Promise<string> {
    this.assertRequestAllowed(options.method ?? "GET", path);
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const authKey = useSuperadmin
      ? (this.config.superadminKey ?? this.config.apiKey)
      : this.config.apiKey;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${authKey}`,
    };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }

    try {
      const response = await fetch(url, {
        ...options,
        redirect: "error",
        ...this.fetchInit,
        headers: { ...headers, ...(options.headers as Record<string, string>) },
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status);
      }

      return await readResponse(response);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Cortex API timeout after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Status ──

  async getStatus(): Promise<CortexStatus> {
    return this.request<CortexStatus>("/status");
  }

  // ── Analyzer methods ──

  async listAnalyzers(): Promise<Analyzer[]> {
    return this.request<Analyzer[]>("/analyzer");
  }

  async getAnalyzer(analyzerId: string): Promise<Analyzer> {
    return this.request<Analyzer>(`/analyzer/${encodeURIComponent(analyzerId)}`);
  }

  async deleteAnalyzer(analyzerId: string): Promise<void> {
    await this.request<void>(
      `/analyzer/${encodeURIComponent(analyzerId)}`,
      { method: "DELETE" },
    );
  }

  async runAnalyzer(
    analyzerId: string,
    data: RunAnalyzerRequest,
  ): Promise<Job> {
    this.assertRequestAllowed("POST", "/analyzer/run");
    await validateObservableTarget(data.dataType, data.data, this.config.allowPrivateTargets ?? false);
    return this.request<Job>(
      `/analyzer/${encodeURIComponent(analyzerId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  }

  async runAnalyzerWithFile(
    analyzerId: string,
    file: {
      content: Buffer;
      filename: string;
      contentType: string;
    },
    options: {
      tlp: number;
      pap: number;
      message?: string;
    },
  ): Promise<Job> {
    this.assertRequestAllowed("POST", "/analyzer/run");
    if (file.content.byteLength > MAX_FILE_BYTES) throw new Error("Analysis file exceeds byte limit");
    const url = `${this.baseUrl}/analyzer/${encodeURIComponent(analyzerId)}/run`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const formData = new FormData();

      // Cortex expects _json field with metadata and attachment field with file
      const jsonData = JSON.stringify({
        dataType: "file",
        tlp: options.tlp,
        pap: options.pap,
        message: options.message ?? "",
      });
      formData.append("_json", new Blob([jsonData], { type: "application/json" }));

      const fileBuffer = Uint8Array.from(file.content).buffer;
      const fileBlob = new Blob([fileBuffer], { type: file.contentType });
      formData.append("attachment", fileBlob, file.filename);

      const response = await fetch(url, {
        method: "POST",
        redirect: "error",
        ...this.fetchInit,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status);
      }

      return parseResponse<Job>(await readResponse(response));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Cortex API timeout after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Analyzer Definition methods ──

  async listAnalyzerDefinitions(): Promise<AnalyzerDefinition[]> {
    return this.request<AnalyzerDefinition[]>("/analyzerdefinition", {}, true);
  }

  async getAnalyzerDefinition(defId: string): Promise<AnalyzerDefinition> {
    return this.request<AnalyzerDefinition>(
      `/analyzerdefinition/${encodeURIComponent(defId)}`,
      {},
      true,
    );
  }

  async enableAnalyzer(data: EnableWorkerRequest): Promise<Analyzer> {
    return this.request<Analyzer>(
      `/organization/analyzer/${encodeURIComponent(data.name)}`,
      {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          configuration: data.configuration,
          rate: data.rate ?? 100,
          rateUnit: data.rateUnit ?? "Day",
          jobCache: data.jobCache ?? 10,
        }),
      },
    );
  }

  // ── Responder Definition methods ──

  async listResponderDefinitions(): Promise<ResponderDefinition[]> {
    return this.request<ResponderDefinition[]>("/responderdefinition", {}, true);
  }

  async enableResponder(data: EnableWorkerRequest): Promise<Responder> {
    return this.request<Responder>(
      `/organization/responder/${encodeURIComponent(data.name)}`,
      {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          configuration: data.configuration,
          rate: data.rate ?? 100,
          rateUnit: data.rateUnit ?? "Day",
        }),
      },
    );
  }

  async deleteResponder(responderId: string): Promise<void> {
    await this.request<void>(
      `/responder/${encodeURIComponent(responderId)}`,
      { method: "DELETE" },
    );
  }

  // ── Job methods ──

  async getJob(jobId: string): Promise<Job> {
    return this.request<Job>(`/job/${encodeURIComponent(jobId)}`);
  }

  async getJobReport(jobId: string): Promise<JobReport> {
    return this.request<JobReport>(
      `/job/${encodeURIComponent(jobId)}/report`,
    );
  }

  /**
   * Ask Cortex to hold the request until the job finishes or `timeoutSeconds`
   * elapses. The client-side timeout for this call is the requested wait plus
   * a transport margin (never less than the configured timeout), so the
   * advertised wait is not cut short by `CORTEX_TIMEOUT`.
   */
  async waitAndGetReport(
    jobId: string,
    timeoutSeconds: number = 300,
  ): Promise<JobReport> {
    return this.request<JobReport>(
      `/job/${encodeURIComponent(jobId)}/waitreport?atMost=${timeoutSeconds}second`,
      {},
      false,
      {
        timeoutMs: Math.max(
          this.timeout,
          timeoutSeconds * 1000 + WAIT_REPORT_MARGIN_MS,
        ),
        dispatcher: this.waitReportDispatcher,
      },
    );
  }

  async searchJobs(query: JobSearchQuery): Promise<Job[]> {
    const params = new URLSearchParams();
    if (query.range !== undefined) params.set("range", query.range);
    for (const sort of query.sort ?? []) params.append("sort", sort);
    const search = params.toString();
    return this.request<Job[]>(`/job/_search${search ? `?${search}` : ""}`, {
      method: "POST",
      body: JSON.stringify({ query: query.query ?? {} }),
    }, false, { readOnlySearch: true });
  }

  async getJobArtifacts(jobId: string): Promise<Artifact[]> {
    return this.request<Artifact[]>(
      `/job/${encodeURIComponent(jobId)}/artifacts`,
    );
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.request<void>(
      `/job/${encodeURIComponent(jobId)}`,
      { method: "DELETE" },
    );
  }

  // ── Responder methods ──

  async listResponders(): Promise<Responder[]> {
    return this.request<Responder[]>("/responder");
  }

  async runResponder(
    responderId: string,
    data: RunResponderRequest,
  ): Promise<ActionJob> {
    return this.request<ActionJob>(
      `/responder/${encodeURIComponent(responderId)}/run`,
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    );
  }

  // ── Organization methods (superadmin) ──

  get superadminAvailable(): boolean {
    return !!this.config.superadminKey;
  }

  async listOrganizations(): Promise<Organization[]> {
    return this.request<Organization[]>("/organization", {}, true);
  }

  async getOrganization(orgId: string): Promise<Organization> {
    return this.request<Organization>(
      `/organization/${encodeURIComponent(orgId)}`,
      {},
      true,
    );
  }

  async createOrganization(data: {
    name: string;
    description: string;
    status?: string;
  }): Promise<Organization> {
    return this.request<Organization>(
      "/organization",
      {
        method: "POST",
        body: JSON.stringify({
          name: data.name,
          description: data.description,
          status: data.status ?? "Active",
        }),
      },
      true,
    );
  }

  async updateOrganization(
    orgId: string,
    data: { description?: string; status?: string },
  ): Promise<Organization> {
    return this.request<Organization>(
      `/organization/${encodeURIComponent(orgId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(data),
      },
      true,
    );
  }

  // ── User methods (superadmin for cross-org, org admin for own org) ──

  async listUsers(): Promise<CortexUser[]> {
    return this.request<CortexUser[]>("/user", {}, true);
  }

  async getUser(userId: string): Promise<CortexUser> {
    return this.request<CortexUser>(
      `/user/${encodeURIComponent(userId)}`,
      {},
      true,
    );
  }

  async createUser(data: {
    login: string;
    name: string;
    roles: string[];
    organization: string;
    password?: string;
  }): Promise<CortexUser> {
    return this.request<CortexUser>(
      "/user",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
      true,
    );
  }

  async renewUserKey(userId: string): Promise<{ reference: string; fingerprint: string }> {
    this.assertRequestAllowed("POST", "/user/key/renew");
    if (!this.credentialStore) throw new Error("Key rotation requires an approved credential store");
    const key = await this.requestText(
      `/user/${encodeURIComponent(userId)}/key/renew`,
      { method: "POST" },
      true,
    );
    try {
      const { reference } = await this.credentialStore.put(userId, key);
      return { reference, fingerprint: createHash("sha256").update(key).digest("hex") };
    } catch {
      throw new Error("Credential store write failed after key rotation. Recover the key through Cortex administration.");
    }
  }
}
