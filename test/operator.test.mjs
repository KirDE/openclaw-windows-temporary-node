import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const operatorPath = path.resolve("operator.mjs");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "powershell-operator-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { ...process.env, OPENCLAW_POWERSHELL_RELAY_DIR: root };
}

test("operator creates a trusted session with explicit flags", async (t) => {
  const env = await fixture(t);
  const { stdout } = await execFile(process.execPath, [
    operatorPath,
    "create",
    "--no-expiry",
    "--no-confirmation",
    "--timeout-seconds",
    "900",
  ], { env });
  const created = JSON.parse(stdout);
  assert.equal(created.expiresAt, null);
  assert.equal(created.requiresApproval, false);
  assert.ok(created.joinCodeExpiresAt);

  const status = JSON.parse((await execFile(process.execPath, [
    operatorPath,
    "status",
    "--session",
    created.sessionId,
  ], { env })).stdout);
  assert.equal(status.expiresAt, null);
  assert.equal(status.requiresApproval, false);
});

test("operator rejects contradictory expiry options", async (t) => {
  const env = await fixture(t);
  await assert.rejects(
    () => execFile(process.execPath, [
      operatorPath,
      "create",
      "--no-expiry",
      "--ttl-minutes",
      "30",
    ], { env }),
    /cannot be combined/u,
  );
});
