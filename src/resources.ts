import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CortexClient } from "./client.js";

export function registerResources(
  server: McpServer,
  client: CortexClient,
): void {
  server.resource(
    "analyzers",
    "cortex://analyzers",
    {
      description: "List of all enabled Cortex analyzers with their capabilities and supported data types",
      mimeType: "application/json",
    },
    async () => {
      const analyzers = await client.listAnalyzers();
      const summary = analyzers.map((a) => ({
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        dataTypes: a.dataTypeList,
      }));
      return {
        contents: [
          {
            uri: "cortex://analyzers",
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "analyzer-definitions",
    "cortex://analyzer-definitions",
    {
      description:
        "All available Cortex analyzer definitions (installed, not necessarily enabled) with config requirements",
      mimeType: "application/json",
    },
    async () => {
      const defs = await client.listAnalyzerDefinitions();
      const summary = defs.map((d) => ({
        id: d.id,
        name: d.name,
        version: d.version,
        description: d.description,
        dataTypes: d.dataTypeList,
        author: d.author,
        requiresConfig: d.configurationItems.some((c) => c.required),
        requiredFields: d.configurationItems
          .filter((c) => c.required)
          .map((c) => c.name),
      }));
      return {
        contents: [
          {
            uri: "cortex://analyzer-definitions",
            mimeType: "application/json",
            text: JSON.stringify(
              { total: summary.length, definitions: summary },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.resource(
    "responder-definitions",
    "cortex://responder-definitions",
    {
      description:
        "All available Cortex responder definitions with config requirements",
      mimeType: "application/json",
    },
    async () => {
      const defs = await client.listResponderDefinitions();
      const summary = defs.map((d) => ({
        id: d.id,
        name: d.name,
        version: d.version,
        description: d.description,
        dataTypes: d.dataTypeList,
        author: d.author,
        requiresConfig: d.configurationItems.some((c) => c.required),
        requiredFields: d.configurationItems
          .filter((c) => c.required)
          .map((c) => c.name),
      }));
      return {
        contents: [
          {
            uri: "cortex://responder-definitions",
            mimeType: "application/json",
            text: JSON.stringify(
              { total: summary.length, definitions: summary },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.resource(
    "recent-jobs",
    "cortex://jobs/recent",
    {
      description: "Recent Cortex analysis jobs (last 50)",
      mimeType: "application/json",
    },
    async () => {
      const jobs = await client.searchJobs({
        query: {},
        range: "0-50",
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
        contents: [
          {
            uri: "cortex://jobs/recent",
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );
}
