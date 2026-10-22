import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { join } from "node:path";

export interface CortexConfig {
  url: string;
  mode?: "read-only" | "write";
  allowPrivateTargets?: boolean;
  apiKey: string;
  superadminKey?: string;
  verifySsl: boolean;
  timeout: number;
  /**
   * Absolute base directory that `cortex_run_analyzer_file` is confined to when
   * reading files from `filePath`. Undefined disables filesystem file reads
   * entirely (base64 submission still works).
   */
  fileBaseDir?: string;
  /**
   * When true, destructive tools (run responder, delete job, disable analyzer)
   * are permitted. Defaults to false (secure). Set CORTEX_ALLOW_DESTRUCTIVE=1.
   */
  allowDestructive: boolean;
  /**
   * Maximum number of analyzers `cortex_analyze_observable` may fan out to in a
   * single call. Defaults to 10.
   */
  maxFanout: number;
}

function positiveInteger(name: string, fallback: number, maximum: number, message: string): number {
  const raw = (process.env[name] ?? String(fallback)).trim();
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(message);
  }
  return value;
}

function credential(variable: string, name: string): string | undefined {
  if (process.env[variable]) return process.env[variable];
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory) return undefined;
  let fd: number;
  try { fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw new Error(`${variable} credential could not be read`); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536) throw new Error(`${variable} credential exceeds byte limit`);
    const buffer = Buffer.alloc(65_537);
    let size = 0;
    for (;;) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
      if (size > 65_536) throw new Error(`${variable} credential exceeds byte limit`);
    }
    return buffer.subarray(0, size).toString("utf8").trim();
  } finally { closeSync(fd); }
}

export function getConfig(): CortexConfig {
  const url = credential("CORTEX_URL", "cortex-url")?.trim();
  if (!url) {
    throw new Error("CORTEX_URL environment variable is required");
  }

  const mode = process.env.CORTEX_MODE ?? "read-only";
  if (mode !== "read-only" && mode !== "write") {
    throw new Error("CORTEX_MODE must be read-only or write");
  }
  const privateTargets = process.env.CORTEX_ALLOW_PRIVATE_TARGETS ?? "false";
  if (!["true", "false"].includes(privateTargets)) {
    throw new Error("CORTEX_ALLOW_PRIVATE_TARGETS must be true or false");
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || /[?#]/.test(url)) {
      throw new Error("Invalid URL");
    }
  } catch {
    throw new Error("CORTEX_URL must be an absolute HTTP or HTTPS URL without embedded credentials, query string or fragment");
  }

  const apiKey = credential("CORTEX_API_KEY", "cortex-api-key");
  if (!apiKey) {
    throw new Error("CORTEX_API_KEY environment variable is required");
  }

  const superadminKey = process.env.CORTEX_SUPERADMIN_KEY || undefined;
  const verifySslRaw = (process.env.CORTEX_VERIFY_SSL ?? "true").trim().toLowerCase();
  if (verifySslRaw !== "true" && verifySslRaw !== "false") {
    throw new Error("CORTEX_VERIFY_SSL must be true or false");
  }
  const verifySsl = verifySslRaw === "true";
  const timeout = positiveInteger(
    "CORTEX_TIMEOUT", 30, 300,
    "CORTEX_TIMEOUT must be a positive integer between 1 and 300 seconds",
  ) * 1000;

  const fileBaseDirRaw = process.env.CORTEX_FILE_BASE_DIR?.trim();
  const fileBaseDir =
    fileBaseDirRaw && fileBaseDirRaw.length > 0 ? fileBaseDirRaw : undefined;

  const allowDestructive =
    process.env.CORTEX_ALLOW_DESTRUCTIVE === "1" ||
    process.env.CORTEX_ALLOW_DESTRUCTIVE === "true";

  const maxFanout = positiveInteger(
    "CORTEX_MAX_FANOUT", 10, Number.MAX_SAFE_INTEGER,
    "CORTEX_MAX_FANOUT must be a positive integer",
  );

  return {
    url: url.replace(/\/+$/, ""),
    apiKey,
    mode,
    allowPrivateTargets: privateTargets === "true",
    superadminKey,
    verifySsl,
    timeout,
    fileBaseDir,
    allowDestructive,
    maxFanout,
  };
}
