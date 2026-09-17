import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createRelayHandler } from "../server/http.mjs";
import { RelayStore } from "../server/state.mjs";

class Response extends EventEmitter {
  headers = {};
  chunks = [];
  setHeader(name, value) { this.headers[name] = value; }
  end(chunk) { if (chunk) this.chunks.push(Buffer.from(chunk)); this.emit("finish"); }
  json() { return JSON.parse(Buffer.concat(this.chunks).toString("utf8")); }
}

function request(method, url, body, headers = {}) {
  const value = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(value);
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "powershell-http-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RelayStore(root);
  await store.init();
  return { store, handler: createRelayHandler({ store }) };
}

test("serves the PowerShell client without caching", async (t) => {
  const { handler } = await fixture(t);
  const res = new Response();
  await handler(request("GET", "/temporary-powershell/client.ps1"), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const client = Buffer.concat(res.chunks).toString("utf8");
  assert.match(client, /Temporary support session connected/u);
  assert.match(client, /Parameter\(Mandatory = \$true\)/u);
  assert.match(client, /PSObject\.Properties\['id'\]/u);
  assert.match(client, /requiresApproval/u);
  assert.match(client, /Trusted session: commands run without confirmation/u);
  assert.doesNotMatch(client, /-not \$command\.id/u);
  assert.doesNotMatch(client, /RelayUrl\s*=/u);
});

test("trusted enrollment advertises no expiry and no confirmation", async (t) => {
  const { store, handler } = await fixture(t);
  const created = await store.createSession({ ttlMs: null, requiresApproval: false });
  const enrollRes = new Response();
  await handler(request("POST", "/temporary-powershell/v1/enroll", {
    joinCode: created.joinCode,
    client: { computerName: "PC" },
  }), enrollRes);
  assert.equal(enrollRes.statusCode, 200);
  assert.equal(enrollRes.json().expiresAt, null);
  assert.equal(enrollRes.json().requiresApproval, false);
});

test("returns an empty successful response while no command is queued", async (t) => {
  const { store, handler } = await fixture(t);
  const created = await store.createSession();
  const enrollRes = new Response();
  await handler(request("POST", "/temporary-powershell/v1/enroll", {
    joinCode: created.joinCode,
    client: { computerName: "PC" },
  }), enrollRes);
  const enrollment = enrollRes.json();

  const pollRes = new Response();
  await handler(request(
    "GET",
    `/temporary-powershell/v1/commands?session=${enrollment.sessionId}`,
    undefined,
    { authorization: `Bearer ${enrollment.clientToken}` },
  ), pollRes);

  assert.equal(pollRes.statusCode, 204);
  assert.equal(Buffer.concat(pollRes.chunks).length, 0);
});

test("enrollment, polling, result and close require the client token", async (t) => {
  const { store, handler } = await fixture(t);
  const created = await store.createSession();
  const enrollRes = new Response();
  await handler(request("POST", "/temporary-powershell/v1/enroll", { joinCode: created.joinCode, client: { computerName: "PC" } }), enrollRes);
  assert.equal(enrollRes.statusCode, 200);
  const enrollment = enrollRes.json();
  const command = await store.enqueueCommand(enrollment.sessionId, "Get-Date");

  const deniedRes = new Response();
  await handler(request("GET", `/temporary-powershell/v1/commands?session=${enrollment.sessionId}`), deniedRes);
  assert.equal(deniedRes.statusCode, 401);

  const headers = { authorization: `Bearer ${enrollment.clientToken}` };
  const pollRes = new Response();
  await handler(request("GET", `/temporary-powershell/v1/commands?session=${enrollment.sessionId}`, undefined, headers), pollRes);
  assert.equal(pollRes.json().id, command.id);

  const resultRes = new Response();
  await handler(request("POST", `/temporary-powershell/v1/results?session=${enrollment.sessionId}`, { commandId: command.id, status: "ok", output: "done" }, headers), resultRes);
  assert.equal(resultRes.statusCode, 200);

  const closeRes = new Response();
  await handler(request("POST", `/temporary-powershell/v1/close?session=${enrollment.sessionId}`, {}, headers), closeRes);
  assert.equal(closeRes.statusCode, 200);
  await assert.rejects(() => store.authenticate(enrollment.sessionId, enrollment.clientToken), /ENOENT/u);
});
