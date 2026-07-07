import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, type CortexConfig } from "./config.js";
import { CortexClient } from "./client.js";
import { serveMcp } from "./mcp-server.js";
import { safeCaughtErrorMessage } from "./safe-error.js";
import type { Analyzer, CortexStatus, Job } from "./types.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

export const HELP = `cortexctrl - Cortex observable-analysis control CLI (alias: cortexctl; MCP adapter: cortex-mcp)

Usage:
  cortexctrl <command> [options]

Commands:
  status [--json]                         Show Cortex status and version data
  analyzers list [options]                List enabled analyzers
  analyzers run <analyzer-id> [options]   Run one analyzer against one observable
  jobs get <job-id> [--json]              Get one job
  mcp                                     Start the MCP server over stdio
  help                                    Show this help
  --version                               Show package version

Analyzer list options:
  --data-type <type>                      Filter analyzers by supported data type

Analyzer run options:
  --data-type <type>                      Observable type, for example ip, domain, url, hash
  --data <value>                          Observable value
  --tlp <0-3>                             TLP value (default: 2)
  --pap <0-3>                             PAP value (default: 2)
  --message <text>                        Optional context message

Safety notes:
  File-path submission stays confined to CORTEX_FILE_BASE_DIR and is not exposed in this first CLI slice.
  Responder and delete commands must require CORTEX_ALLOW_DESTRUCTIVE=1 plus --confirm --destructive.
  Fanout remains opt-in in MCP and is intentionally not exposed here yet.

Global options:
  --json                                  Emit JSON instead of a concise summary
`;

type Parsed =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "mcp" }
  | { kind: "status"; json: boolean }
  | { kind: "analyzers list"; json: boolean; dataType?: string }
  | {
      kind: "analyzers run";
      json: boolean;
      analyzerId: string;
      dataType: string;
      data: string;
      tlp: number;
      pap: number;
      message?: string;
    }
  | { kind: "jobs get"; json: boolean; jobId: string };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CortexCtrlDeps {
  out: (text: string) => void;
  err: (text: string) => void;
  getConfig: () => CortexConfig;
  makeClient: (config: CortexConfig) => CortexClient;
  serve: () => Promise<void>;
}

const DEFAULT_DEPS: CortexCtrlDeps = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  getConfig,
  makeClient: (config) => new CortexClient(config),
  serve: serveMcp,
};

function stripJson(args: string[]): { args: string[]; json: boolean } {
  let json = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--json") json = true;
    else rest.push(arg);
  }
  return { args: rest, json };
}

function flagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
  return value;
}

function intFlag(value: string, flag: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function parseAnalyzerRunOptions(
  analyzerId: string,
  rest: string[],
  json: boolean,
): Extract<Parsed, { kind: "analyzers run" }> {
  let dataType: string | undefined;
  let data: string | undefined;
  let tlp = 2;
  let pap = 2;
  let message: string | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const option = rest[i];
    if (option === "--data-type") {
      dataType = flagValue(rest, i, option);
      i += 1;
    } else if (option === "--data") {
      data = flagValue(rest, i, option);
      i += 1;
    } else if (option === "--tlp") {
      tlp = intFlag(flagValue(rest, i, option), option, 0, 3);
      i += 1;
    } else if (option === "--pap") {
      pap = intFlag(flagValue(rest, i, option), option, 0, 3);
      i += 1;
    } else if (option === "--message") {
      message = flagValue(rest, i, option);
      i += 1;
    } else {
      throw new UsageError(`Unknown analyzers run option: ${option}`);
    }
  }

  if (!dataType) throw new UsageError("analyzers run requires --data-type");
  if (!data) throw new UsageError("analyzers run requires --data");
  return { kind: "analyzers run", json, analyzerId, dataType, data, tlp, pap, message };
}

export function parseArgs(rawArgs: string[]): Parsed {
  const { args, json } = stripJson(rawArgs);
  const [first, second, third, ...rest] = args;

  if (!first || first === "help" || first === "--help" || first === "-h") return { kind: "help" };
  if (first === "--version" || first === "version") return { kind: "version" };
  if (first === "mcp") return { kind: "mcp" };
  if (first === "status") {
    if (second) throw new UsageError(`Unknown status option: ${second}`);
    return { kind: "status", json };
  }
  if (first === "analyzers" && second === "list") {
    let dataType: string | undefined;
    const options = third ? [third, ...rest] : rest;
    for (let i = 0; i < options.length; i += 1) {
      const option = options[i];
      if (option === "--data-type") {
        dataType = flagValue(options, i, option);
        i += 1;
      } else {
        throw new UsageError(`Unknown analyzers list option: ${option}`);
      }
    }
    return { kind: "analyzers list", json, dataType };
  }
  if (first === "analyzers" && second === "run") {
    if (!third) throw new UsageError("analyzers run requires an analyzer id");
    return parseAnalyzerRunOptions(third, rest, json);
  }
  if (first === "jobs" && second === "get") {
    if (!third) throw new UsageError("jobs get requires a job id");
    if (rest.length > 0) throw new UsageError(`Unknown jobs get option: ${rest[0]}`);
    return { kind: "jobs get", json, jobId: third };
  }

  throw new UsageError(`Unknown command: ${args.join(" ")}`);
}

function dateText(value: number | undefined): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

function analyzerSummary(analyzer: Analyzer): Record<string, unknown> {
  return {
    id: analyzer.id,
    name: analyzer.name,
    version: analyzer.version,
    description: analyzer.description,
    data_types: analyzer.dataTypeList,
  };
}

function jobSummary(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    analyzer_id: job.analyzerId,
    analyzer_name: job.analyzerName,
    data_type: job.dataType,
    data: job.data,
    tlp: job.tlp,
    pap: job.pap,
    created_at: dateText(job.createdAt),
    start_date: dateText(job.startDate),
    end_date: dateText(job.endDate),
  };
}

function compactLine(values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

async function runStatus(parsed: Extract<Parsed, { kind: "status" }>, client: CortexClient) {
  const status = await client.getStatus();
  const result = {
    healthy: true,
    version: status.versions.Cortex,
    versions: status.versions,
    auth_types: status.config.authType,
    capabilities: status.config.capabilities,
  };
  if (parsed.json) return { code: 0, text: JSON.stringify(result, null, 2) };
  return {
    code: 0,
    text: compactLine([
      "status=ok",
      `cortex=${status.versions.Cortex}`,
      `elastic4play=${status.versions.Elastic4Play}`,
      `play=${status.versions.Play}`,
    ]),
  };
}

async function runAnalyzersList(parsed: Extract<Parsed, { kind: "analyzers list" }>, client: CortexClient) {
  let analyzers = await client.listAnalyzers();
  if (parsed.dataType) {
    analyzers = analyzers.filter((analyzer) => analyzer.dataTypeList.includes(parsed.dataType!));
  }
  const result = {
    analyzers: analyzers.map(analyzerSummary),
    count: analyzers.length,
    data_type: parsed.dataType,
  };
  if (parsed.json) return { code: 0, text: JSON.stringify(result, null, 2) };
  const lines = [`analyzers count=${analyzers.length}${parsed.dataType ? ` data_type=${parsed.dataType}` : ""}`];
  for (const analyzer of result.analyzers) {
    lines.push(
      compactLine([
        `id=${analyzer.id}`,
        `name=${analyzer.name}`,
        analyzer.version ? `version=${analyzer.version}` : undefined,
        Array.isArray(analyzer.data_types) ? `data_types=${analyzer.data_types.join(",")}` : undefined,
      ]),
    );
  }
  return { code: 0, text: lines.join("\n") };
}

async function runAnalyzerRun(parsed: Extract<Parsed, { kind: "analyzers run" }>, client: CortexClient) {
  const job = await client.runAnalyzer(parsed.analyzerId, {
    data: parsed.data,
    dataType: parsed.dataType,
    tlp: parsed.tlp,
    pap: parsed.pap,
    message: parsed.message,
  });
  const result = {
    job: jobSummary(job),
    message: `Analysis job submitted. Use cortexctrl jobs get ${job.id} to check status.`,
  };
  if (parsed.json) return { code: 0, text: JSON.stringify(result, null, 2) };
  return {
    code: 0,
    text: compactLine([
      `job_id=${job.id}`,
      `status=${job.status}`,
      job.analyzerId ? `analyzer_id=${job.analyzerId}` : undefined,
      job.analyzerName ? `analyzer=${job.analyzerName}` : undefined,
      job.dataType ? `data_type=${job.dataType}` : undefined,
    ]),
  };
}

async function runJobGet(parsed: Extract<Parsed, { kind: "jobs get" }>, client: CortexClient) {
  const job = await client.getJob(parsed.jobId);
  const result = jobSummary(job);
  if (parsed.json) return { code: 0, text: JSON.stringify(result, null, 2) };
  return {
    code: 0,
    text: compactLine([
      `id=${result.id}`,
      `status=${result.status}`,
      result.analyzer_name ? `analyzer=${result.analyzer_name}` : undefined,
      result.data_type ? `data_type=${result.data_type}` : undefined,
      result.data ? `data=${JSON.stringify(result.data)}` : undefined,
    ]),
  };
}

export async function run(rawArgs: string[], deps: Partial<CortexCtrlDeps> = {}): Promise<number> {
  const resolvedDeps = { ...DEFAULT_DEPS, ...deps };
  let parsed: Parsed;
  try {
    parsed = parseArgs(rawArgs);
  } catch (error) {
    if (error instanceof UsageError) {
      resolvedDeps.err(error.message);
      resolvedDeps.err("Run cortexctrl help for usage.");
      return 2;
    }
    throw error;
  }

  if (parsed.kind === "help") {
    resolvedDeps.out(HELP);
    return 0;
  }
  if (parsed.kind === "version") {
    resolvedDeps.out(packageJson.version ?? "0.0.0");
    return 0;
  }
  if (parsed.kind === "mcp") {
    await resolvedDeps.serve();
    return 0;
  }

  let config: CortexConfig | undefined;
  try {
    config = resolvedDeps.getConfig();
    const client = resolvedDeps.makeClient(config);
    const result =
      parsed.kind === "status"
        ? await runStatus(parsed, client)
        : parsed.kind === "analyzers list"
          ? await runAnalyzersList(parsed, client)
          : parsed.kind === "analyzers run"
            ? await runAnalyzerRun(parsed, client)
            : await runJobGet(parsed, client);
    resolvedDeps.out(result.text);
    return result.code;
  } catch (error) {
    resolvedDeps.err(
      JSON.stringify({
        error: safeCaughtErrorMessage(error, "Unexpected error", [
          config?.apiKey ?? "",
          config?.superadminKey ?? "",
        ]),
      }),
    );
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
