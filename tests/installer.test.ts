import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
it("generates an unprivileged service with immutable application files and isolated credentials", () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-installer-")); paths.push(root);
  const app = join(root, "opt/cortex-mcp");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(root, "etc/systemd/system"), { recursive: true });
  writeFileSync(join(app, "scripts/store-credential.sh"), readFileSync("scripts/store-credential.sh"));
  writeFileSync(join(app, "index.js"), "example application", { mode: 0o666 });
  const source = readFileSync("scripts/proxmox_install.sh", "utf8");
  const setup = source.slice(source.indexOf("# Clone, configure, build"), source.indexOf('CT_IP=$(pct exec'));
  // Execute the real setup fragment, redirecting all container paths into a
  // temporary root. Only package/network/identity operations are stubbed.
  const harness = `
set -euo pipefail
git() { if [[ "$1" == rev-parse ]]; then printf '%s\\n' "$CORTEX_SOURCE_COMMIT"; fi; }
npm() { test "$1" = ci || test "$1" = run || test "$1" = prune; }
getent() { return 2; }
useradd() { printf 'useradd %s\\n' "$*" >> "$TEST_ROOT/identity.log"; }
chown() { printf 'chown %s\\n' "$*" >> "$TEST_ROOT/identity.log"; }
systemctl() { printf 'systemctl %s\\n' "$*" >> "$TEST_ROOT/systemctl.log"; }
export -f git npm getent useradd chown systemctl
pct() {
  test "$1" = exec && test "$2" = 123 && test "$3" = --
  shift 3
  local arg
  local app_path=/opt/cortex-mcp credentials_path=/etc/cortex-mcp unit_path=/etc/systemd
  local -a mapped=()
  for arg in "$@"; do
    arg="\${arg//"$app_path"/"$TEST_ROOT/opt/cortex-mcp"}"
    arg="\${arg//"$credentials_path"/"$TEST_ROOT/etc/cortex-mcp"}"
    arg="\${arg//"$unit_path"/"$TEST_ROOT/etc/systemd"}"
    mapped+=("$arg")
  done
  "\${mapped[@]}"
}
CTID=123
YELLOW= NC=
CORTEX_SOURCE_COMMIT=a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1
export CORTEX_SOURCE_COMMIT
CORTEX_URL_VAL=https://cortex.example.com
CORTEX_API_KEY_VAL=example-installer-key
${setup}`;
  execFileSync("bash", ["-c", harness], { env: { ...process.env, TEST_ROOT: root } });
  const unit = readFileSync(join(root, "etc/systemd/system/cortex-mcp.service"), "utf8");
  const fields = Object.fromEntries(unit.split("\n").filter(line => line.includes("=")).map(line => {
    const equals = line.indexOf("="); return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  expect(fields.User).toBe("cortex-mcp");
  expect(fields.Group).toBe(fields.User);
  expect(fields.NoNewPrivileges).toBe("true");
  expect(fields.ProtectSystem).toBe("strict");
  expect(fields.ProtectHome).toBe("true");
  expect(fields.PrivateTmp).toBe("true");
  expect(fields.StateDirectory).toBe("cortex-mcp");
  expect(fields.StateDirectoryMode).toBe("0700");
  expect(fields.RuntimeDirectory).toBe("cortex-mcp");
  expect(fields.RuntimeDirectoryMode).toBe("0700");
  expect(fields.UMask).toBe("0077");
  expect(fields.CapabilityBoundingSet).toBe("");
  expect(unit).not.toMatch(/ReadWritePaths=.*(?:\/opt|\/etc)/);
  expect(unit).not.toContain("example-installer-key");
  const identity = readFileSync(join(root, "identity.log"), "utf8");
  expect(identity).toMatch(/useradd .*--system.*--user-group.*--shell \/usr\/sbin\/nologin cortex-mcp/);
  expect(identity).toContain(`chown -R root:root ${app}`);
  expect(statSync(join(app, "index.js")).mode & 0o022).toBe(0);
  expect(statSync(app).mode & 0o022).toBe(0);
  expect(readFileSync(join(root, "etc/cortex-mcp/cortex-api-key"), "utf8")).toBe("example-installer-key");
  expect(statSync(join(root, "etc/cortex-mcp/cortex-api-key")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "etc/cortex-mcp")).mode & 0o777).toBe(0o700);
  expect(readFileSync(join(root, "systemctl.log"), "utf8")).toContain("systemctl start cortex-mcp");
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
