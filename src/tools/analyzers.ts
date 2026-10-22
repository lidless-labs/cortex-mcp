import { MAX_FILE_BYTES, readAnalysisFile, formatCortexData } from "../safety.js";
import { z } from "zod";
import { realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CortexClient } from "../client.js";

/**
 * Resolve `filePath` and confine it to `baseDir` (the configured
 * CORTEX_FILE_BASE_DIR). Returns the safe absolute path, or throws if the
 * resolved path escapes the base directory. Uses realpath on both sides so
 * symlinks cannot be used to break out of the jail.
 *
 * Throws a sentinel-typed Error so callers can render a clear, non-leaky
 * message regardless of the underlying fs error.
 */
async function resolveContainedFilePath(
  filePath: string,
  baseDir: string,
): Promise<string> {
  // Realpath the base dir first (it must exist and be a real directory).
  const realBase = await realpath(resolve(baseDir));

  // Resolve the candidate relative to the base dir. An absolute filePath that
  // points outside realBase will be caught by the containment check below.
  const candidate = resolve(realBase, filePath);

  // Realpath the candidate to defeat symlink escapes. The file must exist.
  const realCandidate = await realpath(candidate);

  const baseWithSep = realBase.endsWith(sep) ? realBase : realBase + sep;
  if (realCandidate !== realBase && !realCandidate.startsWith(baseWithSep)) {
    throw new Error("PATH_OUTSIDE_BASE");
  }

  return realCandidate;
}

const DATA_TYPES = [
  "ip",
  "domain",
  "url",
  "fqdn",
  "hash",
  "mail",
  "filename",
  "registry",
  "regexp",
  "other",
] as const;

export function registerAnalyzerTools(
  server: McpServer,
  client: CortexClient,
): void {
  server.tool(
    "cortex_list_analyzers",
    "List all enabled analyzers, optionally filtered by data type",
    {
      dataType: z
        .string().max(65_536)
        .optional()
        .describe(
          "Filter by supported data type (ip, domain, hash, url, file, mail, fqdn, etc.)",
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ dataType }) => {
      try {
        let analyzers = await client.listAnalyzers();

        if (dataType) {
          analyzers = analyzers.filter((a) =>
            a.dataTypeList.includes(dataType),
          );
        }

        const summary = analyzers.map((a) => ({
          id: a.id,
          name: a.name,
          version: a.version,
          description: a.description,
          dataTypes: a.dataTypeList,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(summary),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error listing analyzers: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_get_analyzer",
    "Get details about a specific analyzer by ID",
    {
      analyzerId: z.string().max(65_536).describe("The analyzer ID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ analyzerId }) => {
      try {
        const analyzer = await client.getAnalyzer(analyzerId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(analyzer),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error getting analyzer: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_run_analyzer",
    "Submit an observable to a specific analyzer for analysis",
    {
      analyzerId: z.string().max(65_536).describe("The analyzer ID to run"),
      dataType: z.enum(DATA_TYPES).describe("The observable data type"),
      data: z
        .string().max(65_536)
        .describe("The observable value (IP, domain, hash, URL, etc.)"),
      tlp: z
        .number()
        .int()
        .min(0)
        .max(3)
        .describe(
          "Traffic Light Protocol level (0=WHITE, 1=GREEN, 2=AMBER, 3=RED)",
        ),
      pap: z
        .number()
        .int()
        .min(0)
        .max(3)
        .describe("Permissible Actions Protocol level (0-3)"),
      message: z
        .string().max(65_536)
        .optional()
        .describe("Optional context message for the analysis"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ analyzerId, dataType, data, tlp, pap, message }) => {
      try {
        const job = await client.runAnalyzer(analyzerId, {
          data,
          dataType,
          tlp,
          pap,
          message,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  jobId: job.id,
                  status: job.status,
                  analyzerId: job.analyzerId,
                  message: `Analysis job submitted. Use cortex_get_job or cortex_wait_and_get_report with jobId "${job.id}" to get results.`,
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
              text: formatCortexData(`Error running analyzer: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_run_analyzer_by_name",
    "Run an analyzer by name instead of ID (convenience wrapper)",
    {
      analyzerName: z.string().max(65_536).describe("The analyzer name to search for"),
      dataType: z.enum(DATA_TYPES).describe("The observable data type"),
      data: z.string().max(65_536).describe("The observable value"),
      tlp: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe("Traffic Light Protocol level (default: 2/AMBER)"),
      pap: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe("Permissible Actions Protocol level (default: 2)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ analyzerName, dataType, data, tlp, pap }) => {
      try {
        const analyzers = await client.listAnalyzers();
        const match = analyzers.find(
          (a) =>
            a.name.toLowerCase().includes(analyzerName.toLowerCase()) &&
            a.dataTypeList.includes(dataType),
        );

        if (!match) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatCortexData(`No analyzer found matching "${analyzerName}" that supports data type "${dataType}". Use cortex_list_analyzers to see available analyzers.`),
              },
            ],
            isError: true,
          };
        }

        const job = await client.runAnalyzer(match.id, {
          data,
          dataType,
          tlp,
          pap,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  jobId: job.id,
                  status: job.status,
                  analyzerUsed: { id: match.id, name: match.name },
                  message: `Analysis job submitted to "${match.name}". Use cortex_wait_and_get_report with jobId "${job.id}" to get results.`,
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
              text: formatCortexData(`Error running analyzer by name: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_run_analyzer_file",
    "Submit a file to a specific analyzer for analysis. Provide a file path or base64-encoded content.",
    {
      analyzerId: z.string().max(65_536).describe("The analyzer ID to run"),
      filePath: z
        .string().max(65_536)
        .optional()
        .describe(
          "Path to the file to analyze. Confined to the CORTEX_FILE_BASE_DIR directory; paths outside it (or filesystem reads when CORTEX_FILE_BASE_DIR is unset) are refused. Use fileBase64 for arbitrary content.",
        ),
      fileBase64: z
        .string().max(4 * Math.ceil(MAX_FILE_BYTES / 3))
        .optional()
        .describe("Base64-encoded file content (alternative to filePath)"),
      filename: z
        .string().max(65_536)
        .optional()
        .describe("Filename (required with fileBase64, auto-detected from filePath)"),
      contentType: z
        .string().max(65_536)
        .default("application/octet-stream")
        .describe("MIME type of the file (default: application/octet-stream)"),
      tlp: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe("Traffic Light Protocol level (0=WHITE, 1=GREEN, 2=AMBER, 3=RED)"),
      pap: z
        .number()
        .int()
        .min(0)
        .max(3)
        .default(2)
        .describe("Permissible Actions Protocol level (0-3)"),
      message: z
        .string().max(65_536)
        .optional()
        .describe("Optional context message for the analysis"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ analyzerId, filePath, fileBase64, filename, contentType, tlp, pap, message }) => {
      try {
        let content: Buffer;
        let name: string;

        if (filePath) {
          const baseDir = client.settings.fileBaseDir;
          if (!baseDir) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Reading files from filePath is disabled. Set CORTEX_FILE_BASE_DIR to an allowed base directory to enable it, or submit the file via fileBase64 instead.",
                },
              ],
              isError: true,
            };
          }

          let safePath: string;
          try {
            safePath = await resolveContainedFilePath(filePath, baseDir);
          } catch (e) {
            const reason =
              e instanceof Error && e.message === "PATH_OUTSIDE_BASE"
                ? `filePath resolves outside the allowed base directory (CORTEX_FILE_BASE_DIR).`
                : `filePath could not be resolved within the allowed base directory (CORTEX_FILE_BASE_DIR). Ensure the file exists and is inside that directory.`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: formatCortexData(`Refused to read file: ${reason}`),
                },
              ],
              isError: true,
            };
          }

          content = await readAnalysisFile(safePath);
          name = filename ?? basename(safePath);
        } else if (fileBase64) {
          if (!filename) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "filename is required when using fileBase64.",
                },
              ],
              isError: true,
            };
          }
          if (fileBase64.length > 4 * Math.ceil(MAX_FILE_BYTES / 3)) throw new Error("Analysis file exceeds byte limit");
          content = Buffer.from(fileBase64, "base64");
          if (content.length > MAX_FILE_BYTES) throw new Error("Analysis file exceeds byte limit");
          name = filename;
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: "Provide either filePath or fileBase64 to submit a file for analysis.",
              },
            ],
            isError: true,
          };
        }

        const job = await client.runAnalyzerWithFile(
          analyzerId,
          { content, filename: name, contentType },
          { tlp, pap, message },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  jobId: job.id,
                  status: job.status,
                  analyzerId: job.analyzerId,
                  filename: name,
                  fileSize: content.length,
                  message: `File analysis job submitted. Use cortex_wait_and_get_report with jobId "${job.id}" to get results.`,
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
              text: formatCortexData(`Error running file analysis: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
