export interface CortexConfig {
  url: string;
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

export function getConfig(): CortexConfig {
  const url = process.env.CORTEX_URL?.trim();
  if (!url) {
    throw new Error("CORTEX_URL environment variable is required");
  }

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("Invalid URL");
    }
  } catch {
    throw new Error("CORTEX_URL must be an absolute HTTP or HTTPS URL without embedded credentials");
  }

  const apiKey = process.env.CORTEX_API_KEY;
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
    superadminKey,
    verifySsl,
    timeout,
    fileBaseDir,
    allowDestructive,
    maxFanout,
  };
}
