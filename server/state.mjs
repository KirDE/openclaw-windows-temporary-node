import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const SESSION_ID_PATTERN = /^[a-f0-9]{24}$/u;
const COMMAND_ID_PATTERN = /^[a-f0-9]{24}$/u;

function now() {
  return Date.now();
}

function randomId() {
  return randomBytes(12).toString("hex");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEqualHex(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertId(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
}

async function atomicJson(file, value, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomId()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode, flag: "wx" });
  await rename(temporary, file);
  await chmod(file, mode).catch(() => {});
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export function resolveStateRoot() {
  return path.resolve(
    process.env.OPENCLAW_POWERSHELL_RELAY_DIR ??
      path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(homedir(), ".openclaw"), "powershell-relay"),
  );
}

export class RelayStore {
  constructor(root = resolveStateRoot()) {
    this.root = path.resolve(root);
  }

  async init() {
    await mkdir(path.join(this.root, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, "join"), { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => {});
  }

  async pruneExpired() {
    await this.init();
    const sessionsRoot = path.join(this.root, "sessions");
    for (const name of await readdir(sessionsRoot)) {
      if (!SESSION_ID_PATTERN.test(name)) continue;
      try {
        const session = await this.readSession(name);
        if (session.expiresAt <= now() || session.revokedAt) await this.destroySession(session);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }

  sessionDir(sessionId) {
    assertId(sessionId, SESSION_ID_PATTERN, "session ID");
    return path.join(this.root, "sessions", sessionId);
  }

  async readSession(sessionId) {
    return readJson(path.join(this.sessionDir(sessionId), "session.json"));
  }

  async writeSession(session) {
    await atomicJson(path.join(this.sessionDir(session.id), "session.json"), session);
  }

  assertActive(session) {
    if (session.revokedAt) throw new Error("Session revoked");
    if (session.expiresAt <= now()) throw new Error("Session expired");
  }

  async createSession({ ttlMs = 30 * 60_000, commandTimeoutSeconds = 120 } = {}) {
    await this.init();
    if (!Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 8 * 60 * 60_000) {
      throw new Error("TTL must be between 1 minute and 8 hours");
    }
    if (!Number.isInteger(commandTimeoutSeconds) || commandTimeoutSeconds < 5 || commandTimeoutSeconds > 900) {
      throw new Error("Command timeout must be between 5 and 900 seconds");
    }
    const id = randomId();
    await this.pruneExpired();
    const joinCode = `${randomToken(8).slice(0, 8)}-${randomToken(8).slice(0, 8)}`.toUpperCase();
    const createdAt = now();
    const session = {
      id,
      createdAt,
      expiresAt: createdAt + ttlMs,
      commandTimeoutSeconds,
      joinCodeHash: hash(joinCode),
      clientTokenHash: null,
      enrolledAt: null,
      revokedAt: null,
      closedAt: null,
      client: null,
    };
    const dir = this.sessionDir(id);
    await mkdir(path.join(dir, "commands"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(dir, "results"), { recursive: true, mode: 0o700 });
    await this.writeSession(session);
    await atomicJson(path.join(this.root, "join", `${session.joinCodeHash}.json`), { sessionId: id, expiresAt: session.expiresAt });
    return { session, joinCode };
  }

  async enroll(joinCode, client = {}) {
    const normalized = String(joinCode ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{8}-[A-Z0-9_-]{8}$/u.test(normalized)) throw new Error("Invalid join code");
    const codeHash = hash(normalized);
    const lookupPath = path.join(this.root, "join", `${codeHash}.json`);
    const consumedPath = `${lookupPath}.used-${randomId()}`;
    try {
      await rename(lookupPath, consumedPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("Join code is invalid, expired, or already used");
      throw error;
    }
    try {
      const lookup = await readJson(consumedPath);
      const session = await this.readSession(lookup.sessionId);
      this.assertActive(session);
      if (!safeEqualHex(session.joinCodeHash, codeHash) || session.enrolledAt) {
        throw new Error("Join code is invalid, expired, or already used");
      }
      const clientToken = randomToken();
      session.clientTokenHash = hash(clientToken);
      session.enrolledAt = now();
      session.client = {
        computerName: String(client.computerName ?? "").slice(0, 128),
        userName: String(client.userName ?? "").slice(0, 128),
        isAdmin: client.isAdmin === true,
        psVersion: String(client.psVersion ?? "").slice(0, 64),
      };
      await this.writeSession(session);
      return { session, clientToken };
    } finally {
      await unlink(consumedPath).catch(() => {});
    }
  }

  async authenticate(sessionId, token) {
    const session = await this.readSession(sessionId);
    this.assertActive(session);
    if (!session.clientTokenHash || !safeEqualHex(session.clientTokenHash, hash(String(token ?? "")))) {
      throw new Error("Unauthorized session token");
    }
    return session;
  }

  async enqueueCommand(sessionId, script, timeoutSeconds) {
    const session = await this.readSession(sessionId);
    this.assertActive(session);
    if (!session.enrolledAt) throw new Error("Client is not connected");
    if (typeof script !== "string" || !script.trim() || Buffer.byteLength(script, "utf8") > 256 * 1024) {
      throw new Error("Command must contain 1 to 262144 UTF-8 bytes");
    }
    const effectiveTimeout = timeoutSeconds ?? session.commandTimeoutSeconds;
    if (!Number.isInteger(effectiveTimeout) || effectiveTimeout < 5 || effectiveTimeout > 900) {
      throw new Error("Command timeout must be between 5 and 900 seconds");
    }
    const command = { id: randomId(), createdAt: now(), timeoutSeconds: effectiveTimeout, script };
    await atomicJson(path.join(this.sessionDir(sessionId), "commands", `${command.id}.json`), command);
    return command;
  }

  async nextCommand(sessionId, token) {
    await this.authenticate(sessionId, token);
    const directory = path.join(this.sessionDir(sessionId), "commands");
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(directory)).filter((name) => COMMAND_ID_PATTERN.test(name.replace(/\.json$/u, ""))).sort();
    if (!names.length) return null;
    return readJson(path.join(directory, names[0]));
  }

  async saveResult(sessionId, token, result) {
    await this.authenticate(sessionId, token);
    const commandId = String(result?.commandId ?? "");
    assertId(commandId, COMMAND_ID_PATTERN, "command ID");
    const status = String(result?.status ?? "");
    if (!["ok", "error", "timeout", "denied"].includes(status)) throw new Error("Invalid result status");
    const output = String(result?.output ?? "");
    if (Buffer.byteLength(output, "utf8") > 1024 * 1024) throw new Error("Result exceeds 1 MiB");
    const resultPath = path.join(this.sessionDir(sessionId), "results", `${commandId}.json`);
    try {
      await stat(resultPath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const commandPath = path.join(this.sessionDir(sessionId), "commands", `${commandId}.json`);
    await stat(commandPath);
    await atomicJson(resultPath, {
      commandId,
      status,
      output,
      completedAt: now(),
    });
    await unlink(commandPath).catch(() => {});
  }

  async readResult(sessionId, commandId) {
    assertId(commandId, COMMAND_ID_PATTERN, "command ID");
    try {
      return await readJson(path.join(this.sessionDir(sessionId), "results", `${commandId}.json`));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async close(sessionId, token) {
    const session = await this.authenticate(sessionId, token);
    session.closedAt = now();
    session.revokedAt = session.closedAt;
    await this.destroySession(session);
  }

  async revoke(sessionId) {
    const session = await this.readSession(sessionId);
    session.revokedAt = session.revokedAt ?? now();
    await this.destroySession(session);
    return session;
  }

  async destroySession(session) {
    const lookupPath = path.join(this.root, "join", `${session.joinCodeHash}.json`);
    await unlink(lookupPath).catch(() => {});
    await rm(this.sessionDir(session.id), { recursive: true, force: true });
  }
}
