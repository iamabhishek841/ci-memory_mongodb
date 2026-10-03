import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getDatabaseConfig } from "./config.js";
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
  if (origin && origin !== `http://${request.headers.host}`) throw new RequestError(403, "Cross-origin run requests are not enabled.");
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
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { status: "ok", service: "ci-memory-api" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/ready") {
      if (!getDatabaseConfig()) { send(response, 503, { status: "not_ready", database: "not_configured" }); return; }
      try { await pingDatabase(); send(response, 200, { status: "ready", database: "connected" }); }
      catch { send(response, 503, { status: "not_ready", database: "unavailable" }); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/runs") {
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
