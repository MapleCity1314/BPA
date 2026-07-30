import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type {
  ControlBackend,
  CreateRunInput,
  StagingLeaseRequest,
  SubmitTaskInput
} from "@bpa/operator-console-contracts";
import { ConsoleUserFacingError } from "./user-facing-error.js";

const SESSION_COOKIE = "bpa_console_session";
const JSON_LIMIT_BYTES = 512 * 1024;
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

interface SessionRecord {
  csrfToken: string;
  lastSeenAt: number;
}

interface LeaseRecord {
  maxBytes: number;
}

export interface ConsoleHostOptions {
  backend: ControlBackend;
  staticRoot: string;
  now?: () => number;
  tokenBytes?: () => Uint8Array;
  idleTimeoutMs?: number;
  logError?: (error: unknown) => void;
}

export interface ConsoleHostHandle {
  origin: string;
  launchUrl: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function randomToken(tokenBytes: () => Uint8Array): string {
  return Buffer.from(tokenBytes()).toString("base64url");
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

async function readBody(
  request: IncomingMessage,
  limitBytes: number
): Promise<Uint8Array> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > limitBytes
  ) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求内容超过允许大小。");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limitBytes) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求内容超过允许大小。");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(request, JSON_LIMIT_BYTES);
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求格式无效。");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "请求字段无效。");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maxLength = 512
): string {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength
  ) {
    throw new HttpError(400, "INVALID_REQUEST", `${key} 字段无效。`);
  }
  return value;
}

function parseRunInput(value: unknown): CreateRunInput {
  const record = asRecord(value);
  const inputs = asRecord(record.inputs);
  const bindings = asRecord(record.resourceBindings);
  for (const input of Object.values(inputs)) {
    if (!["string", "number", "boolean"].includes(typeof input)) {
      throw new HttpError(400, "INVALID_REQUEST", "工作流输入字段无效。");
    }
  }
  const resourceBindings: Record<string, string> = {};
  for (const [key, binding] of Object.entries(bindings)) {
    if (typeof binding !== "string" || !binding) {
      throw new HttpError(400, "INVALID_REQUEST", "浏览器资源绑定无效。");
    }
    resourceBindings[key] = binding;
  }
  return {
    workflowId: requiredString(record, "workflowId"),
    workflowVersion: requiredString(record, "workflowVersion", 128),
    inputs: inputs as Record<string, string | number | boolean>,
    resourceBindings
  };
}

function parseTaskInput(value: unknown): SubmitTaskInput {
  const record = asRecord(value);
  const decision = requiredString(record, "decision", 256);
  const note = record.note;
  if (note !== undefined && (typeof note !== "string" || note.length > 4000)) {
    throw new HttpError(400, "INVALID_REQUEST", "备注内容无效。");
  }
  return { decision, ...(typeof note === "string" ? { note } : {}) };
}

function parseLeaseInput(value: unknown): StagingLeaseRequest {
  const record = asRecord(value);
  const allowed = new Set([
    "fileName",
    "mediaType",
    "sizeBytes",
    "sha256",
    "purpose"
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "上传请求只能包含文件元数据，不能包含本地路径。"
    );
  }
  const sizeBytes = record.sizeBytes;
  if (
    !Number.isSafeInteger(sizeBytes) ||
    (sizeBytes as number) < 0 ||
    (sizeBytes as number) > UPLOAD_LIMIT_BYTES
  ) {
    throw new HttpError(400, "INVALID_REQUEST", "文件大小无效。");
  }
  const purpose = record.purpose;
  if (purpose !== "dataset" && purpose !== "evidence") {
    throw new HttpError(400, "INVALID_REQUEST", "上传用途无效。");
  }
  const sha256 = record.sha256;
  if (
    sha256 !== undefined &&
    (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sha256))
  ) {
    throw new HttpError(400, "INVALID_REQUEST", "文件摘要无效。");
  }
  return {
    fileName: requiredString(record, "fileName", 255),
    mediaType: requiredString(record, "mediaType", 255),
    sizeBytes: sizeBytes as number,
    purpose,
    ...(typeof sha256 === "string" ? { sha256: sha256.toLowerCase() } : {})
  };
}

function mimeType(path: string): string {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon"
    }[extname(path)] ?? "application/octet-stream"
  );
}

function sanitizeDownloadName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return safe || "bpa-download";
}

export async function startConsoleHost(
  options: ConsoleHostOptions
): Promise<ConsoleHostHandle> {
  const now = options.now ?? Date.now;
  const tokenBytes = options.tokenBytes ?? (() => randomBytes(32));
  const logError =
    options.logError ??
    ((error: unknown) => {
      console.error("[bpa-console-host] request failed", error);
    });
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new Error("idleTimeoutMs must be a positive integer");
  }
  const staticRoot = resolve(options.staticRoot);
  const launchToken = randomToken(tokenBytes);
  const launchTokenDigest = digest(launchToken);
  let launchTokenAvailable = true;
  const sessions = new Map<string, SessionRecord>();
  const leases = new Map<string, LeaseRecord>();
  let expectedHost = "";
  let expectedOrigin = "";

  const getSession = (request: IncomingMessage): SessionRecord => {
    const token = parseCookies(request)[SESSION_COOKIE];
    const session = token ? sessions.get(digest(token).toString("hex")) : undefined;
    if (!token || !session) {
      throw new HttpError(401, "SESSION_REQUIRED", "工作台会话已失效，请重新打开。");
    }
    if (now() - session.lastSeenAt >= idleTimeoutMs) {
      sessions.delete(digest(token).toString("hex"));
      throw new HttpError(401, "SESSION_EXPIRED", "工作台已闲置超时，请重新打开。");
    }
    session.lastSeenAt = now();
    return session;
  };

  const verifyRequestBoundary = (request: IncomingMessage): void => {
    if (request.headers.host !== expectedHost) {
      throw new HttpError(403, "INVALID_HOST", "请求来源无效。");
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== expectedOrigin
    ) {
      throw new HttpError(403, "INVALID_ORIGIN", "请求来源无效。");
    }
  };

  const requireMutationSession = (request: IncomingMessage): SessionRecord => {
    const session = getSession(request);
    const csrf = request.headers["x-bpa-csrf-token"];
    if (typeof csrf !== "string" || !safeEqual(csrf, session.csrfToken)) {
      throw new HttpError(403, "CSRF_REJECTED", "安全校验失败，请刷新工作台。");
    }
    return session;
  };

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      verifyRequestBoundary(request);
      const url = new URL(request.url ?? "/", expectedOrigin);
      const path = url.pathname;
      if (
        /%2f|%5c/i.test(request.url ?? "") ||
        path.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        throw new HttpError(404, "NOT_FOUND", "页面不存在。");
      }
      if (path.startsWith("/api/")) {
        if (request.method === "OPTIONS") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", "不支持跨来源请求。");
        }

        if (request.method === "POST" && path === "/api/session/exchange") {
          const supplied = request.headers["x-bpa-console-token"];
          if (
            !launchTokenAvailable ||
            typeof supplied !== "string" ||
            !timingSafeEqual(digest(supplied), launchTokenDigest)
          ) {
            throw new HttpError(401, "TOKEN_REJECTED", "启动链接已失效，请重新打开。");
          }
          launchTokenAvailable = false;
          const sessionToken = randomToken(tokenBytes);
          const csrfToken = randomToken(tokenBytes);
          sessions.set(digest(sessionToken).toString("hex"), {
            csrfToken,
            lastSeenAt: now()
          });
          response.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`
          );
          writeJson(response, 200, { csrfToken, idleTimeoutMs });
          return;
        }

        if (request.method === "GET" && path === "/api/session") {
          const session = getSession(request);
          writeJson(response, 200, {
            csrfToken: session.csrfToken,
            idleTimeoutMs
          });
          return;
        }

        if (request.method === "GET" && path === "/api/dashboard") {
          getSession(request);
          writeJson(response, 200, await options.backend.getDashboard());
          return;
        }
        if (request.method === "GET" && path === "/api/workflows") {
          getSession(request);
          writeJson(response, 200, await options.backend.listWorkflows());
          return;
        }
        if (request.method === "POST" && path === "/api/runs") {
          requireMutationSession(request);
          writeJson(
            response,
            201,
            await options.backend.createRun(parseRunInput(await readJson(request)))
          );
          return;
        }
        const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
        if (request.method === "GET" && runMatch) {
          getSession(request);
          writeJson(
            response,
            200,
            await options.backend.getRun(decodeURIComponent(runMatch[1]!))
          );
          return;
        }
        if (request.method === "GET" && path === "/api/tasks") {
          getSession(request);
          writeJson(response, 200, await options.backend.listTasks());
          return;
        }
        const taskMatch = /^\/api\/tasks\/([^/]+)\/submit$/.exec(path);
        if (request.method === "POST" && taskMatch) {
          requireMutationSession(request);
          await options.backend.submitTask(
            decodeURIComponent(taskMatch[1]!),
            parseTaskInput(await readJson(request))
          );
          writeJson(response, 200, { accepted: true });
          return;
        }
        if (request.method === "POST" && path === "/api/uploads/leases") {
          requireMutationSession(request);
          const input = parseLeaseInput(await readJson(request));
          const lease = await options.backend.createStagingLease(input);
          leases.set(lease.id, {
            maxBytes: Math.min(lease.maxBytes, input.sizeBytes, UPLOAD_LIMIT_BYTES)
          });
          writeJson(response, 201, lease);
          return;
        }
        const uploadMatch = /^\/api\/uploads\/leases\/([^/]+)\/content$/.exec(path);
        if (request.method === "PUT" && uploadMatch) {
          requireMutationSession(request);
          const leaseId = decodeURIComponent(uploadMatch[1]!);
          const lease = leases.get(leaseId);
          if (!lease) {
            throw new HttpError(404, "LEASE_NOT_FOUND", "上传凭证不存在或已使用。");
          }
          const body = await readBody(request, lease.maxBytes);
          const expectedSha256 = request.headers["x-bpa-content-sha256"];
          const receipt = await options.backend.uploadStagingLease(
            leaseId,
            body,
            typeof expectedSha256 === "string" ? expectedSha256 : undefined
          );
          leases.delete(leaseId);
          writeJson(response, 201, receipt);
          return;
        }
        const lineageMatch = /^\/api\/runs\/([^/]+)\/lineage$/.exec(path);
        if (request.method === "GET" && lineageMatch) {
          getSession(request);
          writeJson(
            response,
            200,
            await options.backend.getEvidenceLineage(
              decodeURIComponent(lineageMatch[1]!)
            )
          );
          return;
        }
        if (request.method === "GET" && path === "/api/downloads") {
          getSession(request);
          writeJson(
            response,
            200,
            await options.backend.listDownloads(url.searchParams.get("runId") ?? undefined)
          );
          return;
        }
        const downloadMatch = /^\/api\/downloads\/([^/]+)$/.exec(path);
        if (request.method === "GET" && downloadMatch) {
          getSession(request);
          const download = await options.backend.getDownload(
            decodeURIComponent(downloadMatch[1]!)
          );
          response.statusCode = 200;
          response.setHeader("Content-Type", download.mediaType);
          response.setHeader(
            "Content-Disposition",
            `attachment; filename="${sanitizeDownloadName(download.fileName)}"`
          );
          response.setHeader("Content-Length", String(download.body.byteLength));
          response.setHeader("Cache-Control", "no-store");
          response.end(download.body);
          return;
        }
        throw new HttpError(404, "NOT_FOUND", "请求的功能不存在。");
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "该页面只允许读取。");
      }
      const requested = path === "/" ? "index.html" : path.slice(1);
      let filePath = resolve(staticRoot, requested);
      if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) {
        throw new HttpError(404, "NOT_FOUND", "页面不存在。");
      }
      try {
        if (!(await stat(filePath)).isFile()) throw new Error("not a file");
      } catch {
        filePath = resolve(staticRoot, "index.html");
      }
      const body = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", mimeType(filePath));
      response.setHeader(
        "Cache-Control",
        extname(filePath) === ".html"
          ? "no-store"
          : "public, max-age=31536000, immutable"
      );
      response.setHeader("Content-Length", String(body.byteLength));
      if (request.method === "HEAD") response.end();
      else response.end(body);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof HttpError) && !(error instanceof ConsoleUserFacingError)) {
        logError(error);
      }
      const failure =
        error instanceof HttpError
          ? error
          : error instanceof ConsoleUserFacingError
            ? new HttpError(503, "BACKEND_UNAVAILABLE", error.message)
          : new HttpError(500, "INTERNAL_ERROR", "工作台服务暂时不可用，请稍后重试。");
      writeJson(response, failure.status, {
        error: { code: failure.code, message: failure.message }
      });
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Console Host did not bind an IPv4 address");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;

  return {
    origin: expectedOrigin,
    launchUrl: `${expectedOrigin}/#token=${encodeURIComponent(launchToken)}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      })
  };
}
