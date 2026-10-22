import { formatCortexData } from "./safety.js";
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
      mimeType: "text/plain",
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
            mimeType: "text/plain",
            text: formatCortexData(summary),
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
      mimeType: "text/plain",
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
            mimeType: "text/plain",
            text: formatCortexData(
              { total: summary.length, definitions: summary },
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
      mimeType: "text/plain",
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
            mimeType: "text/plain",
            text: formatCortexData(
              { total: summary.length, definitions: summary },
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
      mimeType: "text/plain",
    },
    async () => {
      const jobs = await client.searchJobs({
        query: { _field: "status", _value: "*" },
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
            mimeType: "text/plain",
            text: formatCortexData(summary),
          },
        ],
      };
    },
  );
}
