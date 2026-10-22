import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("writes credentials literally through stdin with owner-only permissions", () => {
  const path = mkdtempSync(join(tmpdir(), "cortex-example-")); paths.push(path);
  const file = join(path, "example-credential");
  const credential = 'example-$(touch example-marker);`touch example-marker`\nexample';
  execFileSync("bash", ["scripts/store-credential.sh", file], { input: credential, cwd: process.cwd() });
  expect(readFileSync(file, "utf8")).toBe(credential);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(path).mode & 0o777).toBe(0o700);
  const result = spawnSync("test", ["!", "-e", "example-marker"]);
  expect(result.status).toBe(0);
});
it("uses silent input and systemd credentials without putting the key in shell source", () => {
  const script = readFileSync("scripts/proxmox_install.sh", "utf8");
  expect(script).toMatch(/read -r -s -p "CORTEX_API_KEY/);
  expect(script).toContain('printf \'%s\' "$CORTEX_API_KEY_VAL" | pct exec');
  expect(script).toContain("LoadCredential=cortex-api-key:");
  expect(script).not.toContain("CORTEX_API_KEY=$CORTEX_API_KEY_VAL");
  expect(script).not.toContain('Password:  $CT_PASSWORD');
});
it("pins actions and uses tokenless provenance publishing", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) expect(action).toMatch(/@[a-f0-9]{40}$/);
  expect(workflow).toMatch(/\npermissions:\n  contents: read/);
  expect(workflow).toContain("id-token: write");
  expect(workflow).toContain("npm publish --provenance");
  expect(workflow).not.toContain("NPM_TOKEN");
  expect(workflow).not.toContain("NODE_AUTH_TOKEN");
});
