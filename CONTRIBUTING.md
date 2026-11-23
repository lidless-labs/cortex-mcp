# Contributing to cortex-mcp

cortex-mcp is a Model Context Protocol (MCP) server that exposes [Cortex](https://docs.strangebee.com/cortex/) observable analysis and response to AI clients. Patches are welcome. Before you start, please skim this file so we both spend our time on the right things.

## What kinds of changes land easily

- **Bug fixes** in the Cortex client, tool handlers, data-type auto-detection, fan-out logic, or the safety gates.
- **New tools or resources** that map to a real Cortex API capability not yet covered, with the same typed-input and confirmation conventions as the existing ones.
- **Sharper tool descriptions and prompts** that help a model pick the right tool.
- **Test coverage** for any of the above, especially around the file-read confinement and the destructive-action gates.
- **Docs**: clearer setup recipes, more accurate Configuration table entries.

## What needs a conversation first

- **Changing or removing a tool name, or changing a tool's input shape.** Tool names and arguments are the public surface that users wire into client configs; renaming them later breaks people. Open an issue describing the use case first.
- **Loosening a safety default.** The destructive-action gates (`CORTEX_ALLOW_DESTRUCTIVE`, `confirm=true`, `CORTEX_FILE_BASE_DIR` confinement, capped fan-out) are deliberate. Propose the change in an issue before sending a PR that weakens them.
- **Adding a runtime dependency.** The dependency surface is intentionally small (`@modelcontextprotocol/sdk`, `undici`, `zod`). New runtime deps need a reason.

## What does not land

- Personal details, hostnames, real IPs, account IDs, API keys, or live auth profiles in code, tests, or docs. Use the documentation placeholders (`cortex.example.com`, `192.0.2.x`, `your-org-admin-key`). Keeping that out of the repo is the point of the content-guard checks.
- Code or examples that submit real observables to third-party services without a clear opt-in.
- AI-co-authorship trailers on commits (`Co-Authored-By: <model>`). Conventional commits only.

## Local dev

```bash
git clone https://github.com/lidless-labs/cortex-mcp.git
cd cortex-mcp
npm ci
./scripts/verify
```

`npm run dev` runs the server with `tsx watch` for a fast edit loop. `npm run lint` is a `tsc --noEmit` type check.

CI scans tracked files with Content Guard's public repository policy. To run the same check locally, install Content Guard 0.4.0 and run `content-guard-git --all-tracked --allow-values-from .github/content-guard-allow.json`.

To smoke-test against a real Cortex instance:

```bash
CORTEX_URL=https://cortex.example.com:9001 \
CORTEX_API_KEY=your-key \
CORTEX_SUPERADMIN_KEY=your-superadmin-key \
npx vitest run tests/integration.test.ts
```

## Adding a tool

Tools live under `src/tools/<area>.ts` and are registered with `server.tool(...)`. To add one:

1. Add the handler in the most fitting `src/tools/*.ts` file (or a new one for a new area).
2. Define inputs with `zod` so the schema is typed and validated. If the tool is destructive, gate it behind `confirm=true` (and `CORTEX_ALLOW_DESTRUCTIVE` if it causes real-world side effects), matching the existing responder/delete tools.
3. Add or extend the corresponding method in `src/client.ts` if it needs a new Cortex endpoint.
4. Add a unit test in `tests/tools.test.ts` (and `tests/client.test.ts` for new client methods).
5. Add a row to the tool table in `README.md` and bump the tool count in the heading and badges.

## Filing issues

Please use the templates under `.github/ISSUE_TEMPLATE/`. Before posting any output, remove API keys, private Cortex URLs and hostnames, real IPs, and unredacted absolute paths.

## License

By contributing you agree that your contribution is licensed under the MIT License, same as the rest of the repo.
