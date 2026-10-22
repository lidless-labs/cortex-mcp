/**
 * Integration tests against a live Cortex instance.
 * Run with: CORTEX_URL=http://... CORTEX_API_KEY=... CORTEX_SUPERADMIN_KEY=... npx vitest run tests/integration.test.ts
 *
 * These tests are skipped when CORTEX_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CortexClient } from "../src/client.js";
import type { CortexConfig } from "../src/config.js";

const CORTEX_URL = process.env.CORTEX_URL;
const CORTEX_API_KEY = process.env.CORTEX_API_KEY;
const CORTEX_SUPERADMIN_KEY = process.env.CORTEX_SUPERADMIN_KEY;

const shouldRun = !!CORTEX_URL && !!CORTEX_API_KEY;

describe.skipIf(!shouldRun)("Integration: Live Cortex Instance", () => {
  let client: CortexClient;

  beforeAll(() => {
    const config: CortexConfig = {
      url: CORTEX_URL!,
      apiKey: CORTEX_API_KEY!,
      superadminKey: CORTEX_SUPERADMIN_KEY,
      verifySsl: false,
      timeout: 30000,
      allowDestructive: false,
      mode: process.env.CORTEX_MODE === "write" ? "write" : "read-only",
      maxFanout: 10,
    };
    client = new CortexClient(config);
  });

  // ── Status ──

  describe("Status", () => {
    it("should return Cortex version and health info", async () => {
      const status = await client.getStatus();

      expect(status.versions).toBeDefined();
      expect(status.versions.Cortex).toBeDefined();
      expect(status.config).toBeDefined();
      expect(status.config.authType).toContain("key");

      console.log(`Cortex version: ${status.versions.Cortex}`);
      console.log(`Auth types: ${status.config.authType.join(", ")}`);
      console.log(`Capabilities: ${status.config.capabilities.join(", ")}`);
    });
  });

  // ── Analyzers ──

  describe("Analyzers", () => {
    it("should list analyzers (may be empty on fresh install)", async () => {
      const analyzers = await client.listAnalyzers();
      expect(Array.isArray(analyzers)).toBe(true);
      console.log(`Enabled analyzers: ${analyzers.length}`);
    });
  });

  // ── Analyzer Definitions ──

  describe("Analyzer Definitions", () => {
    it("should list all available analyzer definitions", async () => {
      const defs = await client.listAnalyzerDefinitions();

      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
      console.log(`Analyzer definitions available: ${defs.length}`);

      // Check structure
      const first = defs[0];
      expect(first.id).toBeDefined();
      expect(first.name).toBeDefined();
      expect(first.version).toBeDefined();
      expect(first.dataTypeList).toBeDefined();
      expect(first.configurationItems).toBeDefined();
    });

    it("should find free analyzers (no required config)", async () => {
      const defs = await client.listAnalyzerDefinitions();
      const free = defs.filter(
        (d) => !d.configurationItems.some((c) => c.required),
      );

      expect(free.length).toBeGreaterThan(0);
      console.log(`Free analyzers (no config required): ${free.length}`);
      for (const d of free.slice(0, 5)) {
        console.log(`  ${d.name}: ${d.dataTypeList.join(", ")}`);
      }
    });
  });

  // ── Responder Definitions ──

  describe("Responder Definitions", () => {
    it("should list all available responder definitions", async () => {
      const defs = await client.listResponderDefinitions();

      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
      console.log(`Responder definitions available: ${defs.length}`);
    });
  });

  // ── Enable/Disable Analyzer Lifecycle ──

  describe("Analyzer Lifecycle", () => {
    let enabledAnalyzerId: string | undefined;

    afterAll(async () => {
      // Cleanup: disable the test analyzer if it was enabled
      if (enabledAnalyzerId) {
        try {
          await client.deleteAnalyzer(enabledAnalyzerId);
          console.log(`Cleaned up test analyzer: ${enabledAnalyzerId}`);
        } catch {
          // already cleaned up
        }
      }
    });

    it("should enable a free analyzer", async () => {
      const analyzer = await client.enableAnalyzer({
        name: "Abuse_Finder_3_0",
        configuration: {},
        rate: 100,
        rateUnit: "Day",
        jobCache: 10,
      });

      expect(analyzer.id).toBeDefined();
      expect(analyzer.name).toBe("Abuse_Finder_3_0");
      expect(analyzer.dataTypeList).toContain("ip");
      enabledAnalyzerId = analyzer.id;

      console.log(`Enabled analyzer: ${analyzer.name} (${analyzer.id})`);
    });

    it("should appear in the enabled analyzers list", async () => {
      const analyzers = await client.listAnalyzers();
      const found = analyzers.find((a) => a.name === "Abuse_Finder_3_0");
      expect(found).toBeDefined();
    });

    it("should disable the analyzer", async () => {
      expect(enabledAnalyzerId).toBeDefined();
      await client.deleteAnalyzer(enabledAnalyzerId!);

      const analyzers = await client.listAnalyzers();
      const found = analyzers.find((a) => a.id === enabledAnalyzerId);
      expect(found).toBeUndefined();

      console.log(`Disabled analyzer: ${enabledAnalyzerId}`);
      enabledAnalyzerId = undefined; // prevent afterAll cleanup
    });
  });

  // ── Enable/Disable Responder Lifecycle ──

  describe("Responder Lifecycle", () => {
    let enabledResponderId: string | undefined;

    afterAll(async () => {
      if (enabledResponderId) {
        try {
          await client.deleteResponder(enabledResponderId);
        } catch {
          // already cleaned up
        }
      }
    });

    it("should enable a responder", async () => {
      const responder = await client.enableResponder({
        name: "Mailer_1_0",
        configuration: { from: "test@test.com", smtp_host: "localhost" },
        rate: 100,
        rateUnit: "Day",
      });

      expect(responder.id).toBeDefined();
      expect(responder.name).toBe("Mailer_1_0");
      enabledResponderId = responder.id;

      console.log(`Enabled responder: ${responder.name} (${responder.id})`);
    });

    it("should appear in the enabled responders list", async () => {
      const responders = await client.listResponders();
      const found = responders.find((r) => r.name === "Mailer_1_0");
      expect(found).toBeDefined();
    });

    it("should disable the responder", async () => {
      expect(enabledResponderId).toBeDefined();
      await client.deleteResponder(enabledResponderId!);

      const responders = await client.listResponders();
      const found = responders.find((r) => r.id === enabledResponderId);
      expect(found).toBeUndefined();

      console.log(`Disabled responder: ${enabledResponderId}`);
      enabledResponderId = undefined;
    });
  });

  // ── Jobs ──

  describe("Jobs", () => {
    it("should search jobs (may return empty on fresh install)", async () => {
      const jobs = await client.searchJobs({
        query: { _field: "status", _value: "*" },
        range: "0-10",
        sort: ["-createdAt"],
      });

      expect(Array.isArray(jobs)).toBe(true);
      console.log(`Recent jobs: ${jobs.length}`);
    });
  });

  // ── Organizations (superadmin) ──

  describe.skipIf(!CORTEX_SUPERADMIN_KEY)("Organizations (superadmin)", () => {
    it("should list organizations", async () => {
      const orgs = await client.listOrganizations();

      expect(Array.isArray(orgs)).toBe(true);
      expect(orgs.length).toBeGreaterThan(0);

      console.log(`Organizations: ${orgs.length}`);
      for (const org of orgs) {
        console.log(`  - ${org.name}: ${org.description} [${org.status}]`);
      }
    });

    it("should get a specific organization", async () => {
      const orgs = await client.listOrganizations();
      expect(orgs.length).toBeGreaterThan(0);

      const org = await client.getOrganization(orgs[0].id);
      expect(org.id).toBe(orgs[0].id);
      expect(org.name).toBeDefined();
    });

    it("should update an organization", async () => {
      const orgs = await client.listOrganizations();
      const target = orgs.find((o) => o.name === "Neas") ?? orgs[0];
      const originalDesc = target.description;

      const updated = await client.updateOrganization(target.id, {
        description: "Integration test update",
      });
      expect(updated.description).toBe("Integration test update");

      // Restore original
      await client.updateOrganization(target.id, {
        description: originalDesc,
      });
    });
  });

  // ── Users (superadmin) ──

  describe.skipIf(!CORTEX_SUPERADMIN_KEY)("Users (superadmin)", () => {
    it("should list users", async () => {
      const users = await client.listUsers();

      expect(Array.isArray(users)).toBe(true);
      expect(users.length).toBeGreaterThan(0);

      console.log(`Users: ${users.length}`);
      for (const user of users) {
        console.log(
          `  - ${user.id} (${user.name}): ${user.roles.join(", ")} [${user.organization}]`,
        );
      }
    });

    it("should get a specific user", async () => {
      const users = await client.listUsers();
      const user = await client.getUser(users[0].id);
      expect(user.id).toBe(users[0].id);
    });

  });

  // ── Error handling ──

  describe("Error handling", () => {
    it("should reject invalid API key", async () => {
      const badConfig: CortexConfig = {
        url: CORTEX_URL!,
        apiKey: "invalid-key-12345",
        verifySsl: false,
        timeout: 10000,
        allowDestructive: false,
      mode: process.env.CORTEX_MODE === "write" ? "write" : "read-only",
        maxFanout: 10,
      };
      const badClient = new CortexClient(badConfig);

      // Cortex returns 401 for bad keys on authenticated endpoints
      await expect(badClient.listAnalyzers()).rejects.toThrow(/unauthorized|error/i);
    });

    it("should handle non-existent analyzer gracefully", async () => {
      await expect(
        client.getAnalyzer("nonexistent_analyzer_999"),
      ).rejects.toThrow();
    });
  });
});
