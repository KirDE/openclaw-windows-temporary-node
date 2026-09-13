import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RelayStore } from "./state.mjs";

const CLIENT_PATH = fileURLToPath(new URL("../Connect-TemporaryPowerShell.ps1", import.meta.url));
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function json(res, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(body.length));
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  const value = Buffer.from(body, "utf8");
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.setHeader("content-length", String(value.length));
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(value);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 2 MiB");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearer(req) {
  const value = String(req.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function publicError(error) {
  const message = String(error?.message ?? "Request failed");
  if (/Unauthorized|token|ENOENT|no such file/iu.test(message)) return { status: 401, message: "Unauthorized" };
  if (/invalid|expired|revoked|already used|not connected|missing/iu.test(message)) return { status: 400, message };
  return { status: 500, message: "Request failed" };
}

export function createRelayHandler({ store = new RelayStore(), routeBase = "/temporary-powershell" } = {}) {
  const base = routeBase.replace(/\/$/u, "");
  return async function relayHandler(req, res) {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (!url.pathname.startsWith(base)) return false;
    try {
      if (req.method === "GET" && url.pathname === `${base}/client.ps1`) {
        text(res, 200, await readFile(CLIENT_PATH, "utf8"), "text/plain; charset=utf-8");
        return true;
      }
      if (req.method === "POST" && url.pathname === `${base}/v1/enroll`) {
        const body = await readJson(req);
        const { session, clientToken } = await store.enroll(body.joinCode, body.client);
        json(res, 200, { sessionId: session.id, clientToken, expiresAt: session.expiresAt, pollSeconds: 2 });
        return true;
      }
      if (req.method === "GET" && url.pathname === `${base}/v1/commands`) {
        const sessionId = url.searchParams.get("session") ?? "";
        const command = await store.nextCommand(sessionId, bearer(req));
        if (!command) {
          res.statusCode = 204;
          res.setHeader("cache-control", "no-store");
          res.end();
        } else {
          json(res, 200, command);
        }
        return true;
      }
      if (req.method === "POST" && url.pathname === `${base}/v1/results`) {
        const sessionId = url.searchParams.get("session") ?? "";
        await store.saveResult(sessionId, bearer(req), await readJson(req));
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === "POST" && url.pathname === `${base}/v1/close`) {
        const sessionId = url.searchParams.get("session") ?? "";
        await store.close(sessionId, bearer(req));
        json(res, 200, { ok: true });
        return true;
      }
      json(res, 404, { error: "Not found" });
      return true;
    } catch (error) {
      const failure = publicError(error);
      json(res, failure.status, { error: failure.message });
      return true;
    }
  };
}
