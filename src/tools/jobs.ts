import { formatCortexData } from "../safety.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CortexClient } from "../client.js";

export function registerJobTools(
  server: McpServer,
  client: CortexClient,
): void {
  server.tool(
    "cortex_get_job",
    "Get the status and details of an analysis job",
    {
      jobId: z.string().max(65_536).describe("The job ID to look up"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ jobId }) => {
      try {
        const job = await client.getJob(jobId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(job),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error getting job: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_get_job_report",
    "Get the full report of a completed analysis job",
    {
      jobId: z.string().max(65_536).describe("The job ID to get the report for"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ jobId }) => {
      try {
        const report = await client.getJobReport(jobId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(report),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error getting job report: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_wait_and_get_report",
    "Wait for a job to complete and return the full report (with polling timeout)",
    {
      jobId: z.string().max(65_536).describe("The job ID to wait for"),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(3600)
        .default(300)
        .describe("Timeout in seconds (default: 300, max: 3600)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ jobId, timeout }) => {
      try {
        const report = await client.waitAndGetReport(jobId, timeout);

        const taxonomies = report.report?.summary?.taxonomies ?? [];
        const taxonomySummary = taxonomies.map(
          (t) => `[${t.level}] ${t.namespace}:${t.predicate} = ${t.value}`,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  jobId: report.id,
                  status: report.status,
                  analyzerName: report.analyzerName,
                  taxonomies: taxonomySummary,
                  fullReport: report.report,
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
              text: formatCortexData(`Error waiting for report: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_list_jobs",
    "List recent analysis jobs with optional filters",
    {
      dataType: z
        .string().max(65_536)
        .optional()
        .describe("Filter by data type"),
      analyzerName: z
        .string().max(65_536)
        .optional()
        .describe("Filter by analyzer name"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum number of jobs to return (default: 50)"),
      status: z
        .string().max(65_536)
        .optional()
        .describe(
          "Filter by status (Waiting, InProgress, Success, Failure, Deleted)",
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ dataType, analyzerName, limit, status }) => {
      try {
        const must: Record<string, unknown>[] = [];

        if (dataType) {
          must.push({ _field: "dataType", _value: dataType });
        }
        if (analyzerName) {
          must.push({ _field: "analyzerName", _value: analyzerName });
        }
        if (status) {
          must.push({ _field: "status", _value: status });
        }

        const query: Record<string, unknown> =
          must.length > 0
            ? { _and: must }
            : { _field: "status", _value: "*" };

        const jobs = await client.searchJobs({
          query,
          range: `0-${limit}`,
          sort: ["-createdAt"],
        });

        const summary = jobs.map((j) => ({
          id: j.id,
          analyzerName: j.analyzerName,
          dataType: j.dataType,
          data: j.data,
          status: j.status,
          startDate: j.startDate
            ? new Date(j.startDate).toISOString()
            : undefined,
          endDate: j.endDate
            ? new Date(j.endDate).toISOString()
            : undefined,
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
              text: formatCortexData(`Error listing jobs: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_get_job_artifacts",
    "Get artifacts (extracted observables/IOCs) from a completed analysis job",
    {
      jobId: z.string().max(65_536).describe("The job ID to get artifacts for"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ jobId }) => {
      try {
        const artifacts = await client.getJobArtifacts(jobId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(artifacts),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error getting job artifacts: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_delete_job",
    "Delete a specific analysis job by ID. DESTRUCTIVE: requires confirm=true.",
    {
      jobId: z.string().max(65_536).describe("The job ID to delete"),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "Must be set to true to actually delete the job. Defaults to false as a safety guard.",
        ),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async ({ jobId, confirm }) => {
      try {
        if (!confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatCortexData(`Job NOT deleted. Deletion is irreversible. Re-call with confirm=true to delete job "${jobId}".`),
              },
            ],
            isError: true,
          };
        }
        await client.deleteJob(jobId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Job "${jobId}" deleted successfully.`),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error deleting job: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_cleanup_jobs",
    "Delete multiple jobs by status or age. Useful for cleaning up failed or old jobs.",
    {
      status: z
        .enum(["Failure", "Deleted", "Success", "Waiting", "InProgress"])
        .optional()
        .describe("Delete jobs with this status"),
      olderThanDays: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Delete jobs older than this many days"),
      confirm: z.boolean().default(false).describe("Explicit confirmation required when dryRun=false"),
      dryRun: z
        .boolean()
        .default(true)
        .describe("If true (default), only count matching jobs without deleting them"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum jobs to process (default: 100)"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async ({ status, olderThanDays, dryRun, limit, confirm }) => {
      try {
        if (!dryRun && !confirm) throw new Error("Job cleanup requires confirm=true when dryRun=false");
        if (!dryRun && client.settings.mode !== "write") throw new Error("Job cleanup requires CORTEX_MODE=write");
        if (!dryRun && !client.settings.allowDestructive) throw new Error("Job cleanup requires CORTEX_ALLOW_DESTRUCTIVE=1");
        if (!status && !olderThanDays) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Please specify at least one filter: status or olderThanDays.",
              },
            ],
            isError: true,
          };
        }

        const must: Record<string, unknown>[] = [];
        if (status) {
          must.push({ _field: "status", _value: status });
        }

        const query: Record<string, unknown> =
          must.length > 0
            ? must.length === 1 ? must[0] : { _and: must }
            : { _field: "status", _value: "*" };

        const jobs = await client.searchJobs({
          query,
          range: `0-${limit}`,
          sort: ["-createdAt"],
        });

        let matchingJobs = jobs.slice(0, limit);
        if (olderThanDays) {
          const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
          matchingJobs = matchingJobs.filter(
            (j) => (j.createdAt ?? 0) < cutoff,
          );
        }

        if (dryRun) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatCortexData(
                  {
                    dryRun: true,
                    matchingJobs: matchingJobs.length,
                    message: `Found ${matchingJobs.length} jobs matching criteria. Set dryRun=false and confirm=true to delete them.`,
                    jobs: matchingJobs.map((j) => ({
                      id: j.id,
                      status: j.status,
                      analyzer: j.analyzerName,
                      data: j.data,
                      createdAt: j.createdAt
                        ? new Date(j.createdAt).toISOString()
                        : undefined,
                    })),
                  },
                ),
              },
            ],
          };
        }

        // Actually delete
        const results: PromiseSettledResult<void>[] = [];
        for (let start = 0; start < matchingJobs.length; start += 5) {
          results.push(...await Promise.allSettled(
            matchingJobs.slice(start, start + 5).map((j) => client.deleteJob(j.id)),
          ));
        }

        const deleted = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected").length;

        return {
          isError: deleted === 0 && failed > 0,
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  dryRun: false,
                  deleted,
                  failed,
                  failures: results.flatMap((result, index) => result.status === "rejected"
                    ? [{ jobId: matchingJobs[index].id, error: "Deletion failed" }] : []).slice(0, 5),
                  total: matchingJobs.length,
                  message: `Deleted ${deleted}/${matchingJobs.length} jobs.${failed > 0 ? ` ${failed} deletions failed.` : ""}`,
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
              text: formatCortexData(`Error cleaning up jobs: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
