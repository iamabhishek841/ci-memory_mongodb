import { createServer } from "node:http";
import { getDatabaseConfig, getPort } from "./config.js";
import { closeDatabase, pingDatabase } from "./database.js";

const port = getPort();
getDatabaseConfig();

const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200);
    response.end(JSON.stringify({ status: "ok", service: "ci-memory-api" }));
    return;
  }

  if (request.method === "GET" && request.url === "/ready") {
    if (!getDatabaseConfig()) {
      response.writeHead(503);
      response.end(JSON.stringify({ status: "not_ready", database: "not_configured" }));
      return;
    }
    try {
      await pingDatabase();
      response.writeHead(200);
      response.end(JSON.stringify({ status: "ready", database: "connected" }));
    } catch {
      response.writeHead(503);
      response.end(JSON.stringify({ status: "not_ready", database: "unavailable" }));
    }
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not found" }));
});

server.on("error", (error) => {
  console.error("API failed to start:", error.message);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`CI Memory API listening at http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => {
    void closeDatabase().then(() => process.exit(0), () => process.exit(1));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
