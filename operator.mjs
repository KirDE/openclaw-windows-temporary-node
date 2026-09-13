#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { RelayStore } from "./server/state.mjs";

function usage() {
  console.error(`Usage:
  node operator.mjs create [--ttl-minutes 30] [--timeout-seconds 120]
  node operator.mjs status --session <id>
  node operator.mjs exec --session <id> --command-file <path> [--timeout-seconds 120] [--wait-seconds 180]
  node operator.mjs revoke --session <id>`);
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Invalid arguments");
    options[key.slice(2)] = value;
  }
  return { action, options };
}

function integer(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected integer, got ${value}`);
  return parsed;
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const store = new RelayStore();
try {
  const { action, options } = parseArgs(process.argv.slice(2));
  if (action === "create") {
    const ttlMinutes = integer(options["ttl-minutes"], 30);
    const commandTimeoutSeconds = integer(options["timeout-seconds"], 120);
    const { session, joinCode } = await store.createSession({ ttlMs: ttlMinutes * 60_000, commandTimeoutSeconds });
    console.log(JSON.stringify({ sessionId: session.id, joinCode, expiresAt: new Date(session.expiresAt).toISOString() }));
  } else if (action === "status") {
    if (!options.session) throw new Error("--session is required");
    const session = await store.readSession(options.session);
    console.log(JSON.stringify({
      sessionId: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      enrolled: Boolean(session.enrolledAt),
      revoked: Boolean(session.revokedAt),
      closed: Boolean(session.closedAt),
      client: session.client,
    }));
  } else if (action === "exec") {
    if (!options.session || !options["command-file"]) throw new Error("--session and --command-file are required");
    const script = await readFile(options["command-file"], "utf8");
    const command = await store.enqueueCommand(options.session, script, integer(options["timeout-seconds"], undefined));
    const waitSeconds = integer(options["wait-seconds"], 180);
    const deadline = Date.now() + waitSeconds * 1000;
    let result = null;
    while (!result && Date.now() < deadline) {
      result = await store.readResult(options.session, command.id);
      if (!result) await sleep(1_000);
    }
    if (!result) {
      console.log(JSON.stringify({ commandId: command.id, status: "pending" }));
      process.exitCode = 2;
    } else {
      console.log(JSON.stringify(result));
      if (result.status !== "ok") process.exitCode = 3;
    }
  } else if (action === "revoke") {
    if (!options.session) throw new Error("--session is required");
    const session = await store.revoke(options.session);
    console.log(JSON.stringify({ sessionId: session.id, revoked: true, revokedAt: new Date(session.revokedAt).toISOString() }));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(String(error?.message ?? error));
  usage();
  process.exitCode = 1;
}
