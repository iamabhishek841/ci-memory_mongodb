import { getDatabaseConfig, getHost, getPort, getPublicOrigin } from "./config.js";
import { writePolicy } from "./access.js";
import { closeDatabase, connectDatabase } from "./database.js";
import { createApiServer } from "./http.js";
import { RunService } from "./run-service.js";
import { getRunContext, RunStore } from "./run-store.js";
import { MemoryStore } from "./memory-store.js";
import { InvestigationService } from "./investigation-service.js";

const port = getPort();
const host = getHost();
getPublicOrigin();
writePolicy();
getDatabaseConfig();
const context = getRunContext();
let service: Promise<RunService> | undefined;
async function getService(): Promise<RunService> {
  if (!service) {
    service = connectDatabase().then(async database => {
      const store = new RunStore(database, context);
      await store.initialize();
      const memory = new MemoryStore(database, context);
      await memory.initialize();
      return new RunService(store, new InvestigationService(store, memory));
    }).catch(error => { service = undefined; throw error; });
  }
  return service;
}

const server = createApiServer(getService);
server.on("error", error => { console.error("API failed to start:", error.message); process.exitCode = 1; });
server.listen(port, host, () => { console.log(`CI Memory API listening on ${host}:${port}`); });

function shutdown(): void {
  server.close(() => { void closeDatabase().then(() => process.exit(0), () => process.exit(1)); });
  setTimeout(() => process.exit(1), 30_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
