# Changelog

All notable changes to cortex-mcp are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- State-changing requests now require `CORTEX_MODE=write`. Destructive deletion
  paths require destructive permission, and additional administration and cleanup
  actions require explicit confirmation.
- Key retrieval has been removed. Key rotation requires an approved credential
  store adapter and returns only a store reference and fingerprint.
- External data is framed and bounded, upstream error bodies are omitted, and
  request, response and upload sizes are limited.
- Network observable submissions validate destinations with bounded DNS checks.
  Worker network policy remains necessary for redirects and later DNS changes.
- Installer credentials use silent input, stdin transfer and systemd credentials.
  CI actions are pinned and tag publishing uses OIDC with provenance.
- Job searches send pagination and sorting in URL query parameters. Unfiltered
  job listing, cleanup previews and the recent-jobs resource use an empty query.

- CI now fails when `npm test` fails. The test step no longer sets
  `continue-on-error`, so a failing suite blocks the tag-triggered npm publish
  job, which depends on the test job.

### Added

- Maintainer-health docs: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  GitHub issue forms (`bug`, `feature`, `config`), and a pull request template
  with a no-PII / safety-gate checklist.
- This changelog.

### Changed

- Rewrote the README to lead with what the server is, why it exists, and how it
  differs; added a copy-paste MCP client config using `npx -y thehive-cortex-mcp`,
  a prominent website link, and "Why not something else?" / "What cortex-mcp is
  not" sections. Documentation only; no change to the server, tools, or behavior.

### Fixed

- `cortex_wait_and_get_report` and the report wait in `cortex_analyze_observable`
  now wait for the requested `timeout` instead of failing after `CORTEX_TIMEOUT`
  (30 seconds by default). The wait-report request allows the requested wait plus
  10 seconds, and waits of 300 seconds or more are no longer cut off by the HTTP
  client's built-in 300-second header and body timeouts.

## [1.2.0]

### Added

- 31 MCP tools spanning the Cortex API: status, analyzers, analyzer definitions,
  jobs, responders, responder definitions, bulk analysis, and superadmin
  organization/user management.
- 4 MCP resources and 4 guided prompts (analyze-observable, investigate-ioc,
  setup-cortex, triage-alert).
- Observable data-type auto-detection and capped analyzer fan-out
  (`CORTEX_MAX_FANOUT`).
- Safety gates: confirmation-required destructive tools, responder execution
  behind `CORTEX_ALLOW_DESTRUCTIVE`, `CORTEX_FILE_BASE_DIR`-confined file reads,
  and scoped SSL verification.

[Unreleased]: https://github.com/lidless-labs/cortex-mcp/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/lidless-labs/cortex-mcp/releases/tag/v1.2.0
