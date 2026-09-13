import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayStore } from "../server/state.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "powershell-relay-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RelayStore(root);
  await store.init();
  return store;
}

test("join codes enroll exactly once", async (t) => {
  const store = await fixture(t);
  const { session, joinCode } = await store.createSession();
  const enrollment = await store.enroll(joinCode, { computerName: "PC", userName: "User", isAdmin: false, psVersion: "5.1" });
  assert.equal(enrollment.session.id, session.id);
  assert.ok(enrollment.clientToken.length > 30);
  await assert.rejects(() => store.enroll(joinCode), /already used/u);
});

test("authenticated client receives a command and returns one result", async (t) => {
  const store = await fixture(t);
  const { session, joinCode } = await store.createSession({ commandTimeoutSeconds: 42 });
  const { clientToken } = await store.enroll(joinCode);
  const command = await store.enqueueCommand(session.id, "Get-Date");
  assert.deepEqual(await store.nextCommand(session.id, clientToken), command);
  await assert.rejects(() => store.nextCommand(session.id, "wrong"), /Unauthorized/u);
  await store.saveResult(session.id, clientToken, { commandId: command.id, status: "ok", output: "done" });
  assert.equal((await store.readResult(session.id, command.id)).output, "done");
  assert.equal(await store.nextCommand(session.id, clientToken), null);
});

test("revocation immediately blocks polling and results", async (t) => {
  const store = await fixture(t);
  const { session, joinCode } = await store.createSession();
  const { clientToken } = await store.enroll(joinCode);
  await store.revoke(session.id);
  await assert.rejects(() => store.nextCommand(session.id, clientToken), /ENOENT/u);
});

test("scripts and result payloads are bounded", async (t) => {
  const store = await fixture(t);
  const { session, joinCode } = await store.createSession();
  const { clientToken } = await store.enroll(joinCode);
  await assert.rejects(() => store.enqueueCommand(session.id, "x".repeat(262_145)), /262144/u);
  const command = await store.enqueueCommand(session.id, "hostname");
  await assert.rejects(
    () => store.saveResult(session.id, clientToken, { commandId: command.id, status: "ok", output: "x".repeat(1024 * 1024 + 1) }),
    /1 MiB/u,
  );
});
