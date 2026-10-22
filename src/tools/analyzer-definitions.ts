import { formatCortexData, boundedJsonValue } from "../safety.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CortexClient } from "../client.js";

export function registerAnalyzerDefinitionTools(
  server: McpServer,
  client: CortexClient,
): void {
  server.tool(
    "cortex_list_analyzer_definitions",
    "List all available analyzer definitions (installed but not necessarily enabled). Filter by data type or find analyzers that require no API keys.",
    {
      dataType: z
        .string().max(65_536)
        .optional()
        .describe("Filter by supported data type (ip, domain, hash, url, file, mail, fqdn, etc.)"),
      freeOnly: z
        .boolean()
        .optional()
        .describe("If true, only return analyzers that require no configuration/API keys"),
      search: z
        .string().max(65_536)
        .optional()
        .describe("Search analyzer names and descriptions (case-insensitive)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Maximum results to return (default: 50)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async ({ dataType, freeOnly, search, limit }) => {
      try {
        let defs = await client.listAnalyzerDefinitions();

        if (dataType) {
          defs = defs.filter((d) => d.dataTypeList.includes(dataType));
        }

        if (freeOnly) {
          defs = defs.filter(
            (d) => !d.configurationItems.some((c) => c.required),
          );
        }

        if (search) {
          const q = search.toLowerCase();
          defs = defs.filter(
            (d) =>
              d.name.toLowerCase().includes(q) ||
              d.description.toLowerCase().includes(q),
          );
        }

        const total = defs.length;
        defs = defs.slice(0, limit);

        const summary = defs.map((d) => ({
          id: d.id,
          name: d.name,
          version: d.version,
          description: d.description,
          dataTypes: d.dataTypeList,
          author: d.author,
          requiresConfig: d.configurationItems.some((c) => c.required),
          configFields: d.configurationItems.map((c) => ({
            name: c.name,
            required: c.required,
            type: c.type,
            description: c.description,
          })),
          dockerImage: d.dockerImage,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  total,
                  returned: summary.length,
                  definitions: summary,
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
              text: formatCortexData(`Error listing analyzer definitions: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_enable_analyzer",
    "Enable an analyzer definition in the current organization. Provide configuration values for any required fields.",
    {
      definitionId: z
        .string().max(65_536)
        .describe("The analyzer definition ID (e.g., 'Abuse_Finder_3_0', 'VirusTotal_GetReport_3_1')"),
      configuration: z
        .record(z.string().max(65_536), boundedJsonValue)
        .refine(value => Object.keys(value).length <= 500, "Too many configuration fields")
        .default({})
        .describe("Configuration key-value pairs (API keys, URLs, etc.). Check cortex_list_analyzer_definitions for required fields."),
      rate: z
        .number()
        .int()
        .min(0)
        .default(100)
        .describe("Rate limit: max jobs per rate unit (default: 100)"),
      rateUnit: z
        .enum(["Day", "Hour", "Minute"])
        .default("Day")
        .describe("Rate limit unit (default: Day)"),
      jobCache: z
        .number()
        .int()
        .min(0)
        .default(10)
        .describe("Cache duration in minutes for identical jobs (default: 10)"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async ({ definitionId, configuration, rate, rateUnit, jobCache }) => {
      try {
        const analyzer = await client.enableAnalyzer({
          name: definitionId,
          configuration,
          rate,
          rateUnit,
          jobCache,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(
                {
                  id: analyzer.id,
                  name: analyzer.name,
                  version: analyzer.version,
                  dataTypes: analyzer.dataTypeList,
                  message: `Analyzer "${analyzer.name}" enabled successfully. It can now analyze: ${analyzer.dataTypeList.join(", ")}`,
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
              text: formatCortexData(`Error enabling analyzer: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "cortex_disable_analyzer",
    "Disable (remove) an enabled analyzer from the current organization. DESTRUCTIVE: requires confirm=true.",
    {
      analyzerId: z
        .string().max(65_536)
        .describe("The enabled analyzer's ID (the internal ID from cortex_list_analyzers, not the definition ID)"),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "Must be set to true to actually disable/remove the analyzer. Defaults to false as a safety guard.",
        ),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    async ({ analyzerId, confirm }) => {
      try {
        if (!confirm) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatCortexData(`Analyzer NOT disabled. Re-call with confirm=true to disable/remove analyzer "${analyzerId}".`),
              },
            ],
            isError: true,
          };
        }
        await client.deleteAnalyzer(analyzerId);
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Analyzer "${analyzerId}" has been disabled and removed from the organization.`),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatCortexData(`Error disabling analyzer: ${error instanceof Error ? error.message : String(error)}`),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
