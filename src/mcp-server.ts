import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig, type CortexConfig } from "./config.js";
import { CortexClient } from "./client.js";
import { registerAnalyzerTools } from "./tools/analyzers.js";
import { registerAnalyzerDefinitionTools } from "./tools/analyzer-definitions.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerResponderTools } from "./tools/responders.js";
import { registerResponderDefinitionTools } from "./tools/responder-definitions.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerStatusTools } from "./tools/status.js";
import { registerOrganizationTools } from "./tools/organizations.js";
import { registerUserTools } from "./tools/users.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: string };

export interface CortexServerDeps {
  config?: CortexConfig;
  client?: CortexClient;
}

export function createCortexMcpServer(deps: CortexServerDeps = {}): McpServer {
  const config = deps.config ?? getConfig();
  const client = deps.client ?? new CortexClient(config);
  const server = new McpServer({
    name: "cortex-mcp",
    version: packageJson.version ?? "0.0.0",
    description:
      "MCP server for Cortex - observable analysis and active response engine by StrangeBee/TheHive Project",
  });

  registerAnalyzerTools(server, client);
  registerJobTools(server, client);
  registerResponderTools(server, client);
  registerBulkTools(server, client);
  registerAnalyzerDefinitionTools(server, client);
  registerResponderDefinitionTools(server, client);
  registerStatusTools(server, client);
  registerOrganizationTools(server, client);
  registerUserTools(server, client);
  registerResources(server, client);
  registerPrompts(server);

  return server;
}

function stripSchemaFromToolList(transport: StdioServerTransport): void {
  const send = transport.send.bind(transport);
  (transport as unknown as { send: typeof transport.send }).send = (message) => {
    const tools = (message as { result?: { tools?: unknown } })?.result?.tools;
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (tool?.inputSchema) delete tool.inputSchema.$schema;
        if (tool?.outputSchema) delete tool.outputSchema.$schema;
      }
    }
    return send(message);
  };
}

export async function serveMcp(): Promise<void> {
  const config = getConfig();
  const server = createCortexMcpServer({ config });
  const transport = new StdioServerTransport();
  stripSchemaFromToolList(transport);
  await server.connect(transport);
}
