import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startMcp } from "./mcp-server.js";

export { CortexClient } from "./client.js";
export { getConfig, type CortexConfig } from "./config.js";
export { createCortexMcpServer, serveMcp } from "./mcp-server.js";
export { CliGateError, requireDestructiveCliGate, requireResponderCliGate } from "./cli-safety.js";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (pathToFileURL(entry).href === import.meta.url) return true;
  try {
    // npm may start the executable through a symlink under node_modules/.bin.
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) startMcp();
