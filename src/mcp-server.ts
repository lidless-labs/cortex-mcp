import packageJson from "../package.json";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BoundedStdioServerTransport } from "./transport.js";
import { getConfig, type CortexConfig } from "./config.js";
import { CortexClient } from "./client.js";
import { safeCaughtErrorMessage } from "./safe-error.js";
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

interface CortexServerDeps {
  config?: CortexConfig;
  client?: CortexClient;
}

export function createCortexMcpServer(deps: CortexServerDeps = {}): McpServer {
  const server = new McpServer({
    name: "cortex-mcp",
    version: packageJson.version,
    description:
      "MCP server for Cortex - observable analysis and active response engine by StrangeBee/TheHive Project",
  });

  const client = deps.client ?? new CortexClient(deps.config ?? getConfig());

  // Core analysis tools
  registerAnalyzerTools(server, client);
  registerJobTools(server, client);
  registerResponderTools(server, client);
  registerBulkTools(server, client);

  // Administration tools
  registerAnalyzerDefinitionTools(server, client);
  registerResponderDefinitionTools(server, client);
  registerStatusTools(server, client);
  registerOrganizationTools(server, client);
  registerUserTools(server, client);

  // Resources and prompts
  registerResources(server, client);
  registerPrompts(server);

  return server;
}

export async function serveMcp(): Promise<void> {
  const server = createCortexMcpServer();
  const transport = new BoundedStdioServerTransport();
  // Strip the draft-07 `$schema` the MCP SDK stamps on tool schemas; Anthropic
  // rejects it ("must match JSON Schema draft 2020-12") when the full tool set
  // is sent, e.g. on subagent spawns. Intercept tools/list output here.
  const __send = transport.send.bind(transport);
  (transport as any).send = (message: any) => {
    const tools = message?.result?.tools;
    if (Array.isArray(tools)) {
      for (const t of tools) {
        if (t?.inputSchema) delete t.inputSchema.$schema;
        if (t?.outputSchema) delete t.outputSchema.$schema;
      }
    }
    return __send(message);
  };
  await server.connect(transport);
}

export function startMcp(): void {
  void serveMcp().catch((error: unknown) => {
    console.error("Fatal error:", safeCaughtErrorMessage(error, "Cortex MCP startup failed"));
    process.exitCode = 1;
  });
}
