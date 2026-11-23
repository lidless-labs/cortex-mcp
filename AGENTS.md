# Repository instructions

## GitHub agent attribution

Every issue body, pull request body, and GitHub comment an agent writes or edits on Solomon's behalf in this repository ends with this block. Keep the human author identity. Use the actual model, harness, and client. Credit only work performed, include the provider if a model name is ambiguous, and list each review pass. Report the exact checks and observed results above the block. Credit verification to the model that ran the checks.

```text
Sent on behalf of Solomon by <orchestrator model> via <harness> in <client>
Models used:
- Implementation/build: <model> via <harness>, or none
- Test/verification: <model> via <harness> (checks: listed above), or not run
- Review: <model> via <harness> for each pass, or none
```

Every agent-written review comment and review summary on Solomon's behalf also includes `Review by <model> via <harness> in <client>`.

## Working on cortex-mcp

Run `npm ci` after checkout and `./scripts/verify` before submitting changes. The script runs the type checker, the offline tests and the build in the same order as CI.

The MCP entry point lives in `src/index.ts`. `src/client.ts` wraps the Cortex API. Tool modules live in `src/tools/` and are registered by the entry point. Update the README tool table and count when adding or removing a tool.

Keep ordinary tests offline with mocks or loopback servers. Use placeholders in examples. Live tests require an explicitly configured disposable Cortex instance. Test mutations also require `CORTEX_TEST_MUTATIONS=true`, `CORTEX_MODE=write` and `CORTEX_ALLOW_DESTRUCTIVE=1`.

Preserve the read-only default, `CORTEX_MODE=write` for state changes, `CORTEX_ALLOW_DESTRUCTIVE=1` and explicit confirmation for destructive tools, `CORTEX_FILE_BASE_DIR` for local file analysis, and `CORTEX_MAX_FANOUT` for bulk analysis. Apply API access checks in the client so both tools and command-line entry points enforce them.
