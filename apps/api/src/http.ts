import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { getDatabaseConfig, getPublicOrigin } from "./config.js";
import { requireWriteAccess, writePolicy } from "./access.js";
import { pingDatabase } from "./database.js";
import type { RunService } from "./run-service.js";
import { parseFixtureRequest, parseHistoryQuery, RequestError } from "./validation.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new RequestError(415, "Send application/json.");
  const origin = request.headers.origin;
  const expectedOrigin = getPublicOrigin() || `http://${request.headers.host}`;
  if (origin && origin !== expectedOrigin) throw new RequestError(403, "Cross-origin run requests are not enabled.");
  const body = await new Promise<string>((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4096) chunks.push(chunk);
    });
    request.on("end", () => bytes > 4096 ? reject(new RequestError(413, "Request body exceeds 4 KB.")) : resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new RequestError(400, "Request body could not be read.")));
    request.on("aborted", () => reject(new RequestError(400, "Request was aborted.")));
  });
  try { return JSON.parse(body); } catch { throw new RequestError(400, "Invalid JSON request."); }
}

export function createApiServer(getService: () => Promise<RunService>) {
  const server = createServer((request, response) => {
    void route(request, response).catch(error => {
      if (response.destroyed) return;
      if (error instanceof RequestError) send(response, error.status, { error: error.message });
      else send(response, 503, { error: "Run execution or storage is unavailable. Check local Atlas configuration; no successful save is claimed." });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const assets: Record<string, { file: string; type: string }> = {
      "/": { file: "index.html", type: "text/html; charset=utf-8" },
      "/dashboard.js": { file: "dashboard.js", type: "text/javascript; charset=utf-8" },
      "/dashboard.css": { file: "dashboard.css", type: "text/css; charset=utf-8" },
      "/mark.svg": { file: "mark.svg", type: "image/svg+xml" },
    };
    const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
    if (request.method === "GET" && asset) {
      const content = await readFile(new URL(`../public/${asset.file}`, import.meta.url));
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      });
      response.end(content);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { status: "ok", service: "ci-memory-api" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/app-config") {
      send(response, 200, writePolicy());
      return;
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      if (!getDatabaseConfig()) { send(response, 503, { status: "not_ready", database: "not_configured" }); return; }
      try { await pingDatabase(); send(response, 200, { status: "ready", database: "connected" }); }
      catch { send(response, 503, { status: "not_ready", database: "unavailable" }); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/runs") {
      requireWriteAccess(request);
      const fixture = parseFixtureRequest(await readBody(request));
      if (url.search) throw new RequestError(400, "Run creation does not accept query parameters.");
      const saved = await (await getService()).execute(fixture);
      response.setHeader("Location", `/runs/${saved.runId}`);
      send(response, 201, saved);
      return;
    }
    if (request.method === "GET" && url.pathname === "/runs") {
      const query = parseHistoryQuery(url.searchParams);
      send(response, 200, await (await getService()).store.list(query));
      return;
    }
    if (request.method === "GET" && url.pathname === "/runs/summary") {
      if (url.search) throw new RequestError(400, "Summary does not accept query parameters.");
      send(response, 200, { groups: await (await getService()).store.summary() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/skills") {
      const investigator = (await getService()).investigations;
      if (!investigator) throw new RequestError(503, "Repair memory is unavailable.");
      send(response, 200, { skills: await investigator.memory.listSkills() });
      return;
    }
    const skillMatch = /^\/skills\/([a-f0-9]{32})\/(markdown|revoke)$/.exec(url.pathname);
    if (skillMatch && request.method === "GET" && skillMatch[2] === "markdown") {
      const investigator = (await getService()).investigations;
      if (!investigator) throw new RequestError(503, "Repair memory is unavailable.");
      const skill = await investigator.memory.getSkill(skillMatch[1]!);
      if (!skill) throw new RequestError(404, "Skill not found in this repository scope.");
      response.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="SKILL-${skill._id}.md"`, "Cache-Control": "no-store" });
      response.end(skill.markdown);
      return;
    }
    if (skillMatch && request.method === "POST" && skillMatch[2] === "revoke") {
      requireWriteAccess(request);
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new RequestError(400, "Send an empty JSON object.");
      const investigator = (await getService()).investigations;
      if (!investigator) throw new RequestError(503, "Repair memory is unavailable.");
      const revoked = await investigator.memory.revoke(skillMatch[1]!);
      send(response, revoked ? 200 : 404, { revoked });
      return;
    }
    const investigationMatch = /^\/runs\/([a-f0-9]{32})\/(investigate|investigation)$/.exec(url.pathname);
    if (investigationMatch && request.method === "POST" && investigationMatch[2] === "investigate") {
      requireWriteAccess(request);
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new RequestError(400, "Send an empty JSON object.");
      const investigator = (await getService()).investigations;
      if (!investigator) throw new RequestError(503, "Investigation service is unavailable.");
      send(response, 201, await investigator.investigate(investigationMatch[1]!));
      return;
    }
    if (investigationMatch && request.method === "GET" && investigationMatch[2] === "investigation") {
      const investigator = (await getService()).investigations;
      if (!investigator) throw new RequestError(503, "Investigation service is unavailable.");
      const run = await (await getService()).store.get(investigationMatch[1]!);
      if (!run) throw new RequestError(404, "Run not found in this repository scope.");
      send(response, 200, { investigation: await investigator.memory.latest(investigationMatch[1]!) });
      return;
    }
    const match = /^\/runs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      if (url.search) throw new RequestError(400, "Run detail does not accept query parameters.");
      const run = await (await getService()).store.get(match[1]!);
      send(response, run ? 200 : 404, run || { error: "Run not found in this repository scope." });
      return;
    }
    send(response, 404, { error: "Not found" });
  }
  return server;
}
