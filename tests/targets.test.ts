import { afterEach, describe, expect, it, vi } from "vitest";
import { Resolver } from "node:dns/promises";
import { CortexClient } from "../src/client.js";
const config = { url: "https://cortex.example.com", apiKey: "example", verifySsl: true, timeout: 1000, allowDestructive: false, maxFanout: 10, mode: "write" as const };
const submit = (client: CortexClient, data: string, dataType = "url") => client.runAnalyzer("example", { data, dataType, tlp: 2, pap: 2 });
afterEach(() => vi.restoreAllMocks());
describe("observable targets", () => {
  it.each([
    `http://${[127, 0, 0, 1].join(".")}/`,
    `http://${[169, 254, 169, 254].join(".")}/`,
    `http://${[10, 0, 0, 1].join(".")}/`,
    "http://[::1]/", "http://[::ffff:7f00:1]/", "http://[fe80::1]/", "http://[fc00::1]/",
    "http://2130706433/", "http://0x7f000001/",
  ])("rejects a nonpublic target %s before submission", async value => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(submit(new CortexClient(config), value)).rejects.toThrow("CORTEX_ALLOW_PRIVATE_TARGETS");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a hostname with any private DNS answer", async () => {
    vi.spyOn(Resolver.prototype, "resolve4").mockResolvedValue(["8.8.8.8", [10, 0, 0, 1].join(".")] as never);
    vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue([] as never);
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(submit(new CortexClient(config), "https://example.com/")).rejects.toThrow("CORTEX_ALLOW_PRIVATE_TARGETS");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed on DNS errors", async () => {
    vi.spyOn(Resolver.prototype, "resolve4").mockRejectedValue(Object.assign(new Error("example"), { code: "ETIMEOUT" }));
    vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue([] as never);
    await expect(submit(new CortexClient(config), "https://example.com/")).rejects.toThrow("validate observable target DNS");
  });
  it("permits a public target after DNS validation", async () => {
    vi.spyOn(Resolver.prototype, "resolve4").mockResolvedValue(["8.8.8.8"] as never);
    vi.spyOn(Resolver.prototype, "resolve6").mockResolvedValue([] as never);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"id":"example"}'));
    await expect(submit(new CortexClient(config), "https://example.com/")).resolves.toMatchObject({ id: "example" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("permits private targets only with operator configuration", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"id":"example"}'));
    await expect(submit(new CortexClient({ ...config, allowPrivateTargets: true }), "http://[::1]/")).resolves.toMatchObject({ id: "example" });
  });
  it.each(["file:///example", "https://example:example@example.com/"])("rejects unsupported URL forms %s", async value => {
    await expect(submit(new CortexClient(config), value)).rejects.toThrow("HTTP or HTTPS");
  });
});
