import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BoundedStdioServerTransport } from "./transport.js";
import { getConfig } from "./config.js";
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

async function main(): Promise<void> {
  const config = getConfig();

  // SSL verification is handled per-request via a scoped undici dispatcher in
  // CortexClient (see config.verifySsl). We deliberately do NOT touch the
  // process-global NODE_TLS_REJECT_UNAUTHORIZED, which would weaken TLS for
  // every outbound connection in the process.

  const server = new McpServer({
    name: "cortex-mcp",
    version: "1.2.0",
    description:
      "MCP server for Cortex - observable analysis and active response engine by StrangeBee/TheHive Project",
  });

  const client = new CortexClient(config);

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

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
