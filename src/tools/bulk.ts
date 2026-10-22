import { formatCortexData } from "../safety.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CortexClient } from "../client.js";
import type { JobReport, Taxonomy } from "../types.js";

/**
 * Auto-detect the data type of an observable value.
 */
function detectDataType(value: string): string | null {
  const trimmed = value.trim();

  // IPv4
  if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(trimmed)) return "ip";

  // IPv6 (simplified check)
  if (/^[0-9a-fA-F:]{2,39}(\/\d{1,3})?$/.test(trimmed) && trimmed.includes(":")) return "ip";

  // Email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "mail";

  // URL
  if (/^https?:\/\//i.test(trimmed)) return "url";

  // MD5
  if (/^[a-fA-F0-9]{32}$/.test(trimmed)) return "hash";

  // SHA1
  if (/^[a-fA-F0-9]{40}$/.test(trimmed)) return "hash";

  // SHA256
  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) return "hash";

  // SHA512
  if (/^[a-fA-F0-9]{128}$/.test(trimmed)) return "hash";

  // CVE
  if (/^CVE-\d{4}-\d{4,}$/i.test(trimmed)) return "other";

  // Domain/FQDN (has dots, no spaces, no protocol)
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(trimmed)) {
    return "domain";
  }

  return null;
}

export function registerBulkTools(
  server: McpServer,
  client: CortexClient,
): void {
  server.tool(
    "cortex_analyze_observable",
    "Run applicable analyzers against an observable and collect aggregated results with taxonomy summary. Can auto-detect data type. By default only an explicit allowlist of analyzers runs; set fanOut=true to submit to every applicable analyzer (capped by CORTEX_MAX_FANOUT). Fanning out submits the observable to multiple third-party services, so it is opt-in.",
    {
      data: z.string().max(65_536).describe("The observable value (IP, domain, hash, URL, email, etc.)"),
      dataType: z
        .string().max(65_536)
        .optional()
        .describe("The observable data type. If omitted, will be auto-detected from the value."),
      analyzers: z
        .array(z.string().max(65_536)).max(500)
        .optional()
        .describe(
          "Explicit allowlist of analyzer names (substring match, case-insensitive) to run. Required unless fanOut=true. Only matching analyzers that also support the data type are submitted.",
        ),
      fanOut: z
        .boolean()
        .default(false)
        .describe(
          "If true, submit the observable to ALL applicable analyzers (capped by maxAnalyzers / CORTEX_MAX_FANOUT). Default false: you must pass an `analyzers` allowlist.",
        ),
      maxAnalyzers: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "Hard cap on how many analyzers to run this call. Defaults to and is clamped by the server's CORTEX_MAX_FANOUT (default 10).",
        ),
      tlp: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe("Traffic Light Protocol level (0=WHITE, 1=GREEN, 2=AMBER, 3=RED). Default: 2/AMBER"),
      pap: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe("Permissible Actions Protocol level (0-3). Default: 2"),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(3600)
        .default(300)
        .describe("Timeout in seconds per analyzer (default: 300)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ data, dataType: explicitType, analyzers: analyzerAllowlist, fanOut, maxAnalyzers, tlp, pap, timeout }) => {
      try {
        // Auto-detect data type if not provided
        let dataType = explicitType;
        let autoDetected = false;
        if (!dataType) {
          const detected = detectDataType(data);
          if (!detected) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatCortexData(`Could not auto-detect data type for "${data}". Please specify dataType explicitly (ip, domain, url, hash, mail, fqdn, filename, registry, other).`),
                },
              ],
              isError: true,
            };
          }
          dataType = detected;
          autoDetected = true;
        }

        // Step 1: Find all analyzers that support this data type
        const allAnalyzers = await client.listAnalyzers();
        let applicable = allAnalyzers.filter((a) =>
          a.dataTypeList.includes(dataType!),
        );

        if (applicable.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatCortexData(
                  {
                    observable: { dataType, data, autoDetected },
                    analyzersRun: 0,
                    message: `No enabled analyzers support data type "${dataType}". Use cortex_list_analyzer_definitions to find analyzers to enable.`,
                  },
                ),
              },
            ],
          };
        }

        // Step 1b: Decide which analyzers actually run. Default (conservative)
        // requires an explicit allowlist. Auto-fanout to every applicable
        // analyzer must be explicitly opted into via fanOut=true, and is always
        // capped to bound submissions to third-party services.
        const cap = Math.max(
          1,
          Math.min(
            client.settings.maxFanout,
            maxAnalyzers ?? client.settings.maxFanout,
          ),
        );

        if (analyzerAllowlist && analyzerAllowlist.length > 0) {
          const wanted = analyzerAllowlist.map((n) => n.toLowerCase());
          applicable = applicable.filter((a) =>
            wanted.some((w) => a.name.toLowerCase().includes(w)),
          );
          if (applicable.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatCortexData(
                    {
                      observable: { dataType, data, autoDetected },
                      analyzersRun: 0,
                      message: `None of the requested analyzers (${analyzerAllowlist.join(", ")}) are enabled for data type "${dataType}". Use cortex_list_analyzers to see available analyzers.`,
                    },
                  ),
                },
              ],
            };
          }
        } else if (!fanOut) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatCortexData(
                  {
                    observable: { dataType, data, autoDetected },
                    analyzersRun: 0,
                    applicableAnalyzers: applicable.map((a) => a.name),
                    message: `No analyzers run. Pass an explicit \`analyzers\` allowlist (recommended), or set fanOut=true to run all applicable analyzers (up to ${cap}). Auto-fanout is opt-in because it submits this observable to multiple third-party services.`,
                  },
                ),
              },
            ],
          };
        }

        const capped = applicable.length > cap;
        const selected = applicable.slice(0, cap);

        // Step 2: Submit observable to each selected analyzer. Carry the
        // originating analyzer through Promise.allSettled so names always track
        // the correct analyzer even after filtering rejected results.
        const submissions = await Promise.allSettled(
          selected.map(async (analyzer) => {
            const job = await client.runAnalyzer(analyzer.id, {
              data,
              dataType: dataType!,
              tlp,
              pap,
            });
            return { analyzer: analyzer.name, jobId: job.id };
          }),
        );

        const submitted: Array<{ analyzer: string; jobId: string }> = [];
        const failed: Array<{ analyzer: string; error: string }> = [];
        submissions.forEach((r, i) => {
          if (r.status === "fulfilled") {
            submitted.push(r.value);
          } else {
            failed.push({
              analyzer: selected[i].name,
              error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            });
          }
        });

        // Step 3: Wait for all jobs to complete. Carry the analyzer name
        // through so a rejected wait still attributes to the right analyzer
        // (indexing into `submitted` by position is order-aligned and robust).
        const reports = await Promise.allSettled(
          submitted.map(async ({ analyzer, jobId }) => {
            const report = await client.waitAndGetReport(jobId, timeout);
            return { analyzer, report };
          }),
        );

        // Step 4: Aggregate results
        const allTaxonomies: Array<Taxonomy & { analyzer: string }> = [];
        const results: Array<{
          analyzer: string;
          status: string;
          taxonomies: string[];
        }> = [];

        reports.forEach((result, i) => {
          if (result.status === "fulfilled") {
            const { analyzer, report } = result.value;
            const taxonomies = report.report?.summary?.taxonomies ?? [];
            taxonomies.forEach((t) =>
              allTaxonomies.push({ ...t, analyzer }),
            );
            results.push({
              analyzer,
              status: report.status,
              taxonomies: taxonomies.map(
                (t) =>
                  `[${t.level}] ${t.namespace}:${t.predicate} = ${t.value}`,
              ),
            });
          } else {
            results.push({
              analyzer: submitted[i]?.analyzer ?? "unknown",
              status: "Error",
              taxonomies: [
                `Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              ],
            });
          }
        });

        // Summary by taxonomy level
        const levelCounts = {
          malicious: allTaxonomies.filter((t) => t.level === "malicious").length,
          suspicious: allTaxonomies.filter((t) => t.level === "suspicious").length,
          info: allTaxonomies.filter((t) => t.level === "info").length,
          safe: allTaxonomies.filter((t) => t.level === "safe").length,
        };

        return {
          isError: (submitted.length === 0 && failed.length > 0) ||
            (reports.length > 0 && reports.every(result => result.status === "rejected")),
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  observable: { dataType, data, autoDetected },
                  analyzersRun: submitted.length,
                  analyzersFailed: failed.length,
                  analyzersSkippedByCap: capped
                    ? applicable.length - selected.length
                    : 0,
                  cap,
                  summary: levelCounts,
                  results,
                  submissionErrors: failed.length > 0 ? failed : undefined,
                },
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error analyzing observable: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
