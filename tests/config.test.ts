import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config.js";
import { CortexClient } from "../src/client.js";

beforeEach(() => {
  vi.stubEnv("CORTEX_URL", "https://cortex.example.com/");
  vi.stubEnv("CORTEX_API_KEY", "example-key");
  for (const name of ["CORTEX_TIMEOUT", "CORTEX_VERIFY_SSL", "CORTEX_MAX_FANOUT", "CORTEX_SUPERADMIN_KEY", "CORTEX_FILE_BASE_DIR", "CORTEX_ALLOW_DESTRUCTIVE", "CORTEX_ALLOW_INSECURE_REMOTE_HTTP"]) vi.stubEnv(name, undefined);
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
  it.each(["https://cortex.example.com:9001", "https://cortex.example.com/base/"])("accepts absolute HTTPS URL %s", value => {
    vi.stubEnv("CORTEX_URL", value);
    expect(getConfig().url).toBe(value.replace(/\/+$/, ""));
  });
  it.each(["example.com", "/example", "http://", "ftp://cortex.example.com", "https://example:example@cortex.example.com", "https://example@cortex.example.com", "https://cortex.example.com?tenant=example", "https://cortex.example.com/#proxy", "https://cortex.example.com/?", "https://cortex.example.com/#"])("rejects invalid base URL %s", value => {
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

describe("API transport security", () => {
  it.each([
    "http://cortex.example.com:9001", "http://192.0.2.1", "http://localhost",
    "http://cortex.localhost", "http://localhost.example.com", "http://127.0.0.1.example.com",
    "http://[::ffff:127.0.0.1]", "http://[::ffff:192.0.2.1]", "http://[::2]",
    "http://2130706433", "http://0x7f000001", "http://127.1", "http://%31%32%37.0.0.1",
  ])("rejects nonliteral or remote HTTP before sending credentials: %s", url => {
    vi.stubEnv("CORTEX_URL", url);
    expect(() => getConfig()).toThrow(/HTTPS/);
    expect(() => new CortexClient({ ...getConfigForTest(), url })).toThrow(/HTTPS/);
  });

  it.each(["http://127.0.0.1:9001", "http://127.42.0.3/base", "http://[::1]:9001", "http://[0:0:0:0:0:0:0:1]"])("allows literal loopback without an override: %s", url => {
    vi.stubEnv("CORTEX_URL", url);
    expect(getConfig().url).toBe(url);
    expect(() => new CortexClient(getConfig())).not.toThrow();
  });

  it("requires an explicit override and warns without exposing credentials or URL", () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.stubEnv("CORTEX_URL", "http://cortex.example.com/private-path");
      vi.stubEnv("CORTEX_ALLOW_INSECURE_REMOTE_HTTP", "true");
      const config = getConfig();
      expect(config).toMatchObject({ allowInsecureRemoteHttp: true });
      expect(() => new CortexClient(config)).not.toThrow();
      expect(warning).toHaveBeenCalled();
      const text = warning.mock.calls.flat().join(" ");
      expect(text).toMatch(/unencrypted/i);
      expect(text).not.toContain("example-key");
      expect(text).not.toContain("cortex.example.com");
      expect(text).not.toContain("private-path");
    } finally { warning.mockRestore(); }
  });

  it.each(["1", "yes", "TRUE", ""])("rejects ambiguous insecure HTTP override %j", value => {
    vi.stubEnv("CORTEX_ALLOW_INSECURE_REMOTE_HTTP", value);
    expect(() => getConfig()).toThrow(/CORTEX_ALLOW_INSECURE_REMOTE_HTTP/);
  });

  it.each([false, true])("never accepts userinfo even with override %s and never leaks it", allowInsecureRemoteHttp => {
    const url = "http://user:example-secret@127.0.0.1/";
    vi.stubEnv("CORTEX_URL", url);
    vi.stubEnv("CORTEX_ALLOW_INSECURE_REMOTE_HTTP", String(allowInsecureRemoteHttp));
    for (const run of [() => getConfig(), () => new CortexClient({ ...getConfigForTest(), url, allowInsecureRemoteHttp })]) {
      try { run(); throw new Error("expected rejection"); }
      catch (error) {
        expect(String(error)).toMatch(/without embedded credentials/);
        expect(String(error)).not.toContain("example-secret");
        expect(String(error)).not.toContain(url);
      }
    }
  });
});

function getConfigForTest() {
  return { url: "https://cortex.example.com", apiKey: "example-key", verifySsl: true, timeout: 1000, allowDestructive: false, maxFanout: 10 };
}

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
