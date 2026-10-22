import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config.js";

beforeEach(() => {
  vi.stubEnv("CORTEX_URL", "https://cortex.example.com/");
  vi.stubEnv("CORTEX_API_KEY", "example-key");
  for (const name of ["CORTEX_TIMEOUT", "CORTEX_VERIFY_SSL", "CORTEX_MAX_FANOUT", "CORTEX_SUPERADMIN_KEY", "CORTEX_FILE_BASE_DIR", "CORTEX_ALLOW_DESTRUCTIVE"]) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("startup configuration", () => {
  it("retains the defaults and strips trailing URL slashes", () => {
    expect(getConfig()).toMatchObject({ url: "https://cortex.example.com", apiKey: "example-key", timeout: 30_000, verifySsl: true, maxFanout: 10, allowDestructive: false });
  });
  it.each([["1", 1000], ["30", 30_000], ["300", 300_000], [" 5 ", 5000]])("accepts timeout %s", (value, milliseconds) => {
    vi.stubEnv("CORTEX_TIMEOUT", value);
    expect(getConfig().timeout).toBe(milliseconds);
  });
  it.each(["abc", "", " ", "0", "-5", "301", "1.5", "30seconds", "1e2", "Infinity"])("rejects timeout %j at startup", value => {
    vi.stubEnv("CORTEX_TIMEOUT", value);
    expect(() => getConfig()).toThrow(/^CORTEX_TIMEOUT must be a positive integer between 1 and 300 seconds$/);
  });
  it.each(["http://cortex.example.com:9001", "https://cortex.example.com/base/"])("accepts absolute HTTP URL %s", value => {
    vi.stubEnv("CORTEX_URL", value);
    expect(getConfig().url).toBe(value.replace(/\/+$/, ""));
  });
  it.each(["example.com", "/example", "http://", "ftp://cortex.example.com", "https://example:example@cortex.example.com", "https://example@cortex.example.com"])("rejects invalid base URL %s", value => {
    vi.stubEnv("CORTEX_URL", value);
    expect(() => getConfig()).toThrow("CORTEX_URL must be an absolute HTTP or HTTPS URL without embedded credentials");
  });
  it.each([["true", true], ["TRUE", true], ["false", false], ["FaLsE", false], [" false ", false]])("accepts verify SSL setting %s", (value, expected) => {
    vi.stubEnv("CORTEX_VERIFY_SSL", value);
    expect(getConfig().verifySsl).toBe(expected);
  });
  it.each(["", "yes", "0", "1", "anything"])("rejects verify SSL setting %j", value => {
    vi.stubEnv("CORTEX_VERIFY_SSL", value);
    expect(() => getConfig()).toThrow("CORTEX_VERIFY_SSL must be true or false");
  });
  it.each([["1", 1], ["25", 25], [" 12 ", 12], ["9007199254740991", Number.MAX_SAFE_INTEGER]])("accepts positive fanout %s", (value, expected) => {
    vi.stubEnv("CORTEX_MAX_FANOUT", value);
    expect(getConfig().maxFanout).toBe(expected);
  });
  it.each(["abc", "", "0", "-1", "1.5", "10abc", "Infinity", "9007199254740992"])("rejects invalid fanout %j", value => {
    vi.stubEnv("CORTEX_MAX_FANOUT", value);
    expect(() => getConfig()).toThrow("CORTEX_MAX_FANOUT must be a positive integer");
  });
  it.each(["CORTEX_URL", "CORTEX_API_KEY"])("still requires %s", name => {
    vi.stubEnv(name, undefined);
    expect(() => getConfig()).toThrow(`${name} environment variable is required`);
  });
});

it("uses the trimmed base URL that passed validation", () => {
  vi.stubEnv("CORTEX_URL", " https://cortex.example.com/ ");
  expect(getConfig().url).toBe("https://cortex.example.com");
});

it.each(["1", "true", "0"])("preserves configured credential, file and destructive settings for %s", destructive => {
  vi.stubEnv("CORTEX_SUPERADMIN_KEY", "example-superadmin-key");
  vi.stubEnv("CORTEX_FILE_BASE_DIR", " /example/uploads ");
  vi.stubEnv("CORTEX_ALLOW_DESTRUCTIVE", destructive);
  expect(getConfig()).toMatchObject({ superadminKey: "example-superadmin-key", fileBaseDir: "/example/uploads", allowDestructive: destructive !== "0" });
});
