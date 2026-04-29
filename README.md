<p align="center">
  <img src="docs/assets/cortex-mcp-banner.jpg" alt="cortex-mcp banner">
</p>

<h1 align="center">cortex-mcp</h1>

<p align="center">
  <strong>MCP server for Cortex observable analysis and response automation.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/actions/workflow/status/solomonneas/cortex-mcp/ci.yml?branch=main&style=for-the-badge&label=CI&logo=githubactions&logoColor=white" alt="CI status">
  <img src="https://img.shields.io/npm/v/thehive-cortex-mcp?style=for-the-badge&logo=npm&logoColor=white" alt="npm version">
  <img src="https://img.shields.io/badge/typescript-6.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 6.0">
  <img src="https://img.shields.io/badge/node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/MCP-SDK_1.29-7c3aed?style=for-the-badge" alt="MCP SDK 1.29">
  <img src="https://img.shields.io/badge/Cortex-observable_analysis-52c7c9?style=for-the-badge" alt="Cortex observable analysis">
  <img src="https://img.shields.io/badge/Vitest-4-6E9F18?style=for-the-badge&logo=vitest&logoColor=white" alt="Vitest 4">
  <img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License">
</p>

An MCP (Model Context Protocol) server for [Cortex](https://docs.strangebee.com/cortex/) by StrangeBee/TheHive Project. Cortex automates observable analysis (IPs, URLs, hashes, domains, emails, files) using analyzers and executes response actions via responders. This MCP server exposes Cortex's full analysis and administration pipeline to LLMs.

## Features

- **31 MCP tools** covering the complete Cortex API surface
- **4 MCP resources** for browsing Cortex state
- **4 MCP prompts** with guided workflows (setup, investigation, triage)
- Full analyzer/responder lifecycle: browse definitions, enable, configure, disable
- Auto-detection of observable data types (IP, domain, hash, URL, email)
- Bulk analysis across all applicable analyzers with taxonomy aggregation
- Job cleanup with dry-run support
- User API key management (create, renew, retrieve)
- Organization CRUD with status management
- Dual API key support: org-level operations + superadmin administration

## Prerequisites

- Node.js 20 or later
- A running Cortex instance (v3.x recommended)
- A Cortex API key with appropriate permissions

## Installation

```bash
git clone https://github.com/solomonneas/cortex-mcp.git
cd cortex-mcp
npm install
npm run build
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORTEX_URL` | Yes | - | Cortex base URL (e.g., `http://cortex.example.com:9001`) |
| `CORTEX_API_KEY` | Yes | - | API key for normal operations (org admin level) |
| `CORTEX_SUPERADMIN_KEY` | No | - | Superadmin API key for org/user/definition management |
| `CORTEX_VERIFY_SSL` | No | `true` | Set to `false` to skip SSL verification |
| `CORTEX_TIMEOUT` | No | `30` | Request timeout in seconds |

## Usage

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "cortex": {
      "command": "cortex-mcp",
      "env": {
        "CORTEX_URL": "http://cortex.example.com:9001",
        "CORTEX_API_KEY": "your-org-admin-key",
        "CORTEX_SUPERADMIN_KEY": "your-superadmin-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add cortex \
  --env CORTEX_URL=http://cortex.example.com:9001 \
  --env CORTEX_API_KEY=your-org-admin-key \
  --env CORTEX_SUPERADMIN_KEY=your-superadmin-key \
  -- cortex-mcp
```

Add `--scope user` to make it available from any directory instead of only the current project.

### OpenClaw

If you're running from a source checkout instead of the npm-installed binary, point `command`/`args` at the built `dist/index.js`:

```bash
openclaw mcp set cortex '{
  "command": "node",
  "args": ["/absolute/path/to/cortex-mcp/dist/index.js"],
  "env": {
    "CORTEX_URL": "http://cortex.example.com:9001",
    "CORTEX_API_KEY": "your-org-admin-key",
    "CORTEX_SUPERADMIN_KEY": "your-superadmin-key"
  }
}'
```

Or, with the global npm install:

```bash
openclaw mcp set cortex '{
  "command": "cortex-mcp",
  "env": {
    "CORTEX_URL": "http://cortex.example.com:9001",
    "CORTEX_API_KEY": "your-org-admin-key",
    "CORTEX_SUPERADMIN_KEY": "your-superadmin-key"
  }
}'
```

Then restart the OpenClaw gateway so the new server is picked up:

```bash
systemctl --user restart openclaw-gateway
openclaw mcp list   # confirm "cortex" is registered
```

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) reads MCP config from `~/.hermes/config.yaml` under the `mcp_servers` key. Add an entry:

```yaml
mcp_servers:
  cortex:
    command: "cortex-mcp"
    env:
      CORTEX_URL: "http://cortex.example.com:9001"
      CORTEX_API_KEY: "your-org-admin-key"
      CORTEX_SUPERADMIN_KEY: "your-superadmin-key"
```

Or, when running from a source checkout instead of the global npm install:

```yaml
mcp_servers:
  cortex:
    command: "node"
    args: ["/absolute/path/to/cortex-mcp/dist/index.js"]
    env:
      CORTEX_URL: "http://cortex.example.com:9001"
      CORTEX_API_KEY: "your-org-admin-key"
      CORTEX_SUPERADMIN_KEY: "your-superadmin-key"
```

Then reload MCP from inside a Hermes session:

```
/reload-mcp
```

### Codex CLI

[Codex CLI](https://github.com/openai/codex) registers MCP servers via `codex mcp add`:

```bash
codex mcp add cortex \
  --env CORTEX_URL=http://cortex.example.com:9001 \
  --env CORTEX_API_KEY=your-org-admin-key \
  --env CORTEX_SUPERADMIN_KEY=your-superadmin-key \
  -- cortex-mcp
```

Or, when running from a source checkout:

```bash
codex mcp add cortex \
  --env CORTEX_URL=http://cortex.example.com:9001 \
  --env CORTEX_API_KEY=your-org-admin-key \
  --env CORTEX_SUPERADMIN_KEY=your-superadmin-key \
  -- node /absolute/path/to/cortex-mcp/dist/index.js
```

Codex writes the entry to `~/.codex/config.toml` under `[mcp_servers.cortex]`. Verify with:

```bash
codex mcp list
```

### Standalone

```bash
export CORTEX_URL=http://cortex.example.com:9001
export CORTEX_API_KEY=your-org-admin-key
npm start
```

## MCP Tools (31)

### Status

| Tool | Description |
|------|-------------|
| `cortex_get_status` | Get Cortex instance health, version, and configuration |

### Analyzer Tools

| Tool | Description |
|------|-------------|
| `cortex_list_analyzers` | List all enabled analyzers, optionally filtered by data type |
| `cortex_get_analyzer` | Get details about a specific analyzer by ID |
| `cortex_run_analyzer` | Submit an observable to a specific analyzer for analysis |
| `cortex_run_analyzer_by_name` | Run an analyzer by name instead of ID (convenience wrapper) |
| `cortex_run_analyzer_file` | Submit a file (from path or base64) to an analyzer for analysis |

### Analyzer Definition Tools

| Tool | Description |
|------|-------------|
| `cortex_list_analyzer_definitions` | Browse all 260+ available analyzer definitions with filtering (by data type, free/no-config, search) |
| `cortex_enable_analyzer` | Enable an analyzer definition in the current org with configuration |
| `cortex_disable_analyzer` | Disable (remove) an enabled analyzer |

### Job Tools

| Tool | Description |
|------|-------------|
| `cortex_get_job` | Get the status and details of an analysis job |
| `cortex_get_job_report` | Get the full report of a completed analysis job |
| `cortex_wait_and_get_report` | Wait for a job to complete and return the report |
| `cortex_list_jobs` | List recent analysis jobs with optional filters |
| `cortex_get_job_artifacts` | Get artifacts (extracted IOCs) from a completed job |
| `cortex_delete_job` | Delete a specific job |
| `cortex_cleanup_jobs` | Bulk delete jobs by status or age (with dry-run) |

### Responder Tools

| Tool | Description |
|------|-------------|
| `cortex_list_responders` | List all enabled responders, optionally filtered by data type |
| `cortex_run_responder` | Execute a responder action against a TheHive entity |

### Responder Definition Tools

| Tool | Description |
|------|-------------|
| `cortex_list_responder_definitions` | Browse all 137+ available responder definitions with filtering |
| `cortex_enable_responder` | Enable a responder definition with configuration |
| `cortex_disable_responder` | Disable (remove) an enabled responder |

### Bulk Operations

| Tool | Description |
|------|-------------|
| `cortex_analyze_observable` | Run ALL applicable analyzers with auto-detected data type and aggregated taxonomy results |

### Organization Management (superadmin)

| Tool | Description |
|------|-------------|
| `cortex_list_organizations` | List all organizations |
| `cortex_get_organization` | Get organization details |
| `cortex_create_organization` | Create a new organization |
| `cortex_update_organization` | Update organization description or status |

### User Management (superadmin)

| Tool | Description |
|------|-------------|
| `cortex_list_users` | List all users across organizations |
| `cortex_get_user` | Get user details |
| `cortex_create_user` | Create a new user in an organization |
| `cortex_renew_user_key` | Generate a new API key for a user (invalidates previous) |
| `cortex_get_user_key` | Retrieve a user's current API key |

## MCP Resources (4)

| URI | Description |
|-----|-------------|
| `cortex://analyzers` | Enabled analyzers with capabilities |
| `cortex://analyzer-definitions` | All 260+ available analyzer definitions with config requirements |
| `cortex://responder-definitions` | All 137+ available responder definitions with config requirements |
| `cortex://jobs/recent` | Last 50 analysis jobs |

## MCP Prompts (4)

| Prompt | Description |
|--------|-------------|
| `analyze-observable` | Guided workflow for analyzing an observable through Cortex |
| `investigate-ioc` | Deep investigation workflow for a suspicious IOC |
| `setup-cortex` | Guided setup wizard for fresh Cortex instances (enable free analyzers, configure API keys) |
| `triage-alert` | Structured alert triage workflow with multi-observable analysis and risk assessment |

## Examples

### Set up analyzers from scratch

```
1. Use cortex_list_analyzer_definitions with freeOnly=true to find analyzers
   that need no API keys.
2. Use cortex_enable_analyzer to enable "Abuse_Finder_3_0" with empty config.
3. Use cortex_analyze_observable with data "8.8.8.8" to analyze the IP.
```

### Auto-detect observable type

```
Use cortex_analyze_observable with data "185.220.101.42"
(no dataType needed - auto-detects as IP)
```

### Clean up old failed jobs

```
Use cortex_cleanup_jobs with status "Failure", dryRun true to preview,
then dryRun false to delete.
```

### Analyze a file

```
Use cortex_run_analyzer_file with analyzerId "Yara_3_0",
filePath "/tmp/suspicious.exe" to scan with YARA rules.
```

### Manage API keys

```
Use cortex_renew_user_key with userId "analyst1" to rotate their API key.
```

### Triage a security alert

```
Use the triage-alert prompt with alertDescription "Suspicious outbound traffic
detected" and observables "185.220.101.42, evil.example.com, 44d88612fea8a8f36de82e1278abb02f"
```

## Supported Data Types

| Type | Examples | Auto-detected |
|------|----------|---------------|
| `ip` | `8.8.8.8`, `2001:db8::1` | ✅ |
| `domain` | `example.com` | ✅ |
| `url` | `https://malware.example.com/payload` | ✅ |
| `hash` | MD5, SHA1, SHA256, SHA512 | ✅ |
| `mail` | `user@example.com` | ✅ | <!-- content-guard: allow email -->
| `fqdn` | `mail.example.com` | As domain |
| `filename` | `malware.exe` | Manual |
| `registry` | `HKLM\Software\Malware` | Manual |
| `file` | Binary file uploads | Manual |
| `other` | CVEs, custom types | Manual |

## Testing

```bash
npm test              # Unit tests (36 tests)
npm run test:watch    # Watch mode
npm run lint          # Type check

# Integration tests (requires live Cortex instance)
CORTEX_URL=http://cortex:9001 \
CORTEX_API_KEY=your-key \
CORTEX_SUPERADMIN_KEY=your-superadmin-key \
npx vitest run tests/integration.test.ts
```

## Project Structure

```
cortex-mcp/
  src/
    index.ts                  # MCP server entry point
    config.ts                 # Environment config + validation
    client.ts                 # Cortex REST API client (full surface)
    types.ts                  # Cortex API type definitions
    resources.ts              # MCP resources (4)
    prompts.ts                # MCP prompts (2)
    tools/
      analyzers.ts            # Analyzer tools (list, get, run, run-by-name)
      analyzer-definitions.ts # Definition browsing, enable, disable
      jobs.ts                 # Job management + cleanup
      responders.ts           # Responder tools (list, run)
      responder-definitions.ts # Definition browsing, enable, disable
      bulk.ts                 # Bulk analysis with auto-detect
      status.ts               # Health/version check
      organizations.ts        # Org CRUD (superadmin)
      users.ts                # User CRUD + key management (superadmin)
  tests/
    client.test.ts            # API client unit tests
    tools.test.ts             # Tool handler unit tests
    integration.test.ts       # Live instance integration tests (21 tests)
  scripts/
    proxmox_install.sh        # Proxmox LXC deployment script
```

## Deployment

### Proxmox LXC

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/solomonneas/cortex-mcp/main/scripts/proxmox_install.sh)"
```

## License

MIT
