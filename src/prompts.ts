import { formatCortexData } from "./safety.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "analyze-observable",
    "Guided workflow for analyzing an observable through Cortex analyzers",
    {
      observable: z
        .string().max(65_536)
        .describe("The observable value to analyze (IP, domain, hash, URL, etc.)"),
      context: z
        .string().max(65_536)
        .optional()
        .describe("Optional context about where this observable was found"),
    },
    ({ observable, context }) => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Analyze the following observable using Cortex:

${formatCortexData({ observable, context })}

Please follow these steps:
1. First, determine the data type of this observable (ip, domain, url, hash, mail, fqdn, etc.)
2. Use cortex_list_analyzers to find all analyzers that support this data type
3. Use cortex_analyze_observable to submit it to all applicable analyzers
4. Review the taxonomy results and provide a summary:
   - List any MALICIOUS findings with the analyzer name and details
   - List any SUSPICIOUS findings
   - Summarize INFO and SAFE results
   - Provide an overall risk assessment based on the combined results
5. If any analyzers extracted additional artifacts, list those as potential follow-up IOCs`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "investigate-ioc",
    "Deep investigation workflow for a suspicious indicator of compromise",
    {
      ioc: z.string().max(65_536).describe("The IOC value to investigate"),
      iocType: z
        .string().max(65_536)
        .describe("The IOC type (ip, domain, url, hash, mail, fqdn)"),
    },
    ({ ioc, iocType }) => {
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Perform a deep investigation of the following IOC using Cortex:

${formatCortexData({ ioc, iocType })}

Investigation steps:
1. Use cortex_analyze_observable to run all applicable analyzers against this IOC
2. For each analyzer result:
   - Note the taxonomy level (malicious/suspicious/info/safe)
   - Record specific findings (detection names, scores, categories)
3. Use cortex_get_job_artifacts on each completed job to find related IOCs
4. Cross-reference findings across analyzers:
   - Do multiple analyzers flag this as malicious?
   - Are there consistent detection patterns?
   - What categories/families are identified?
5. For any extracted artifacts (related IPs, domains, hashes):
   - List them as potential pivot points for further investigation
6. Provide a final assessment:
   - Confidence level (high/medium/low) based on analyzer consensus
   - Recommended response actions
   - Suggested responder actions if applicable (use cortex_list_responders to check)`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "setup-cortex",
    "Guided workflow to set up a fresh Cortex instance with analyzers and responders",
    {
      focus: z
        .string().max(65_536)
        .optional()
        .describe("Focus area: 'all' (default), 'free-only' (no API keys), 'ip', 'domain', 'hash', 'file', 'mail'"),
    },
    ({ focus }) => {
      const focusArea = focus ?? "all";
      const freeFilter = focusArea === "free-only" ? " with freeOnly=true" : "";
      const dtFilter = ["ip", "domain", "hash", "file", "mail"].includes(focusArea)
        ? ` with dataType="${focusArea}"`
        : "";

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Set up this Cortex instance with analyzers and responders.
${formatCortexData({ focus: focusArea })}

Steps:
1. Use cortex_get_status to verify the instance is healthy
2. Use cortex_list_analyzers to check what's already enabled
3. Use cortex_list_analyzer_definitions${freeFilter}${dtFilter} to find available analyzers
4. For analyzers that require NO configuration (freeOnly=true):
   - Enable them with cortex_enable_analyzer using empty configuration {}
   - Enable only when the operator has authorized changes and CORTEX_MODE=write
5. For analyzers that need API keys:
   - List their required configurationItems
   - Ask the user which API keys they have available
   - Enable those analyzers with the provided keys
6. Use cortex_list_responder_definitions to find available responders
7. Enable any useful responders
8. Verify the setup:
   - Use cortex_list_analyzers to show all enabled analyzers
   - Group them by data type coverage
   - Identify any gaps in coverage
9. Suggest a test: run cortex_analyze_observable on a known-safe IP like 8.8.8.8

Provide a summary table of:
- Analyzers enabled (grouped by data type)
- Data types with coverage vs gaps
- Responders enabled
- Suggested next steps (API keys to add for better coverage)`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "triage-alert",
    "Guided workflow for triaging a security alert using Cortex analysis",
    {
      alertDescription: z
        .string().max(65_536)
        .describe("Description of the alert or incident"),
      observables: z
        .string().max(65_536)
        .describe("Comma-separated list of observables (IPs, domains, hashes, URLs) from the alert"),
    },
    ({ alertDescription, observables }) => {
      const observableList = observables
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean);

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Triage the following security alert using Cortex:

${formatCortexData({ alertDescription, observables: observableList })}

Triage workflow:
1. For each observable (${observableList.length} total):
   a. Use cortex_analyze_observable to run all applicable analyzers
   b. Note the data type (auto-detected) and results
2. Cross-correlate findings:
   - Which observables are flagged as malicious?
   - Are there connections between the observables (same campaign, same threat actor)?
   - Check job artifacts for additional IOCs not in the original alert
3. Risk assessment:
   - Overall severity: Critical / High / Medium / Low / Informational
   - Confidence level based on analyzer consensus
   - False positive likelihood
4. Recommended actions:
   - Immediate containment steps
   - Which responders to execute (use cortex_list_responders)
   - Additional observables to investigate
   - Escalation recommendation

Present findings in a structured triage report format.`,
            },
          },
        ],
      };
    },
  );
}
