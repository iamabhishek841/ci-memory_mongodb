import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MongoClient } from "mongodb";
import { assertOwnedCollection, collectionName } from "./namespaces.js";
import { scenarios, type Command, type EventPayload, type Fixture, type RunResult, type Scenario, type Schedule, type Scope, type TraceEvent, type WorkerConfig, type WorkerMessage } from "./types.js";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);

interface RunOptions {
  scenario: Scenario;
  scope: Scope;
  schedule?: Schedule;
  onEvent?: (event: TraceEvent) => void;
}

class FixtureWorker {
  private worker: Worker;
  private nextCommand = 0;
  private pending = new Map<number, { resolve: (value: boolean) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly ready: Promise<void>;

  constructor(config: WorkerConfig, onEvent: (event: EventPayload) => void) {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: config });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture worker startup timed out.")), 15_000);
      this.worker.on("message", (message: WorkerMessage) => {
        if (message.type === "event" && message.event) onEvent(message.event);
        if (message.type === "ready") { clearTimeout(timer); resolve(); }
        if (message.type === "error" && message.commandId === undefined) { clearTimeout(timer); reject(new Error(message.message)); }
        if (message.commandId !== undefined) {
          const pending = this.pending.get(message.commandId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.commandId);
            if (message.type === "error") pending.reject(new Error(message.message));
            else pending.resolve(message.passed ?? true);
          }
        }
      });
      this.worker.on("error", () => {
        clearTimeout(timer);
        const error = new Error("Fixture worker failed. Inspect local runner configuration.");
        reject(error);
        this.rejectPending(error);
      });
      this.worker.on("exit", () => {
        clearTimeout(timer);
        const error = new Error("Fixture worker exited before completing the requested work.");
        reject(error);
        this.rejectPending(error);
      });
    });
  }

  async command(command: Command): Promise<boolean> {
    await this.ready;
    const commandId = ++this.nextCommand;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(new Error("Fixture command timed out."));
      }, 15_000);
      this.pending.set(commandId, { resolve, reject, timer });
      this.worker.postMessage({ commandId, command });
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    try { await this.command("stop"); } catch { /* Terminate the owned fixture worker below. */ }
    this.rejectPending(new Error("Fixture worker stopped."));
    await this.worker.terminate();
  }
}

export async function runFixture(options: RunOptions): Promise<RunResult> {
  if (!scenarios.includes(options.scenario)) throw new Error("Unsupported demo scenario.");
  if (options.scope !== "shared" && options.scope !== "worker") throw new Error("Unsupported collection scope.");
  const schedule = options.schedule ?? "cleanup-between-write-and-read";
  if (schedule !== "cleanup-between-write-and-read" && schedule !== "cleanup-before-write") throw new Error("Unsupported fixture schedule.");
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri || !/^mongodb(?:\+srv)?:\/\//.test(uri) || /[<>]/.test(uri)) throw new Error("Configure MONGODB_URI in the root .env before running fixtures.");
  const database = process.env.MONGODB_DB?.trim() || "ci_memory";
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database)) throw new Error("Invalid MONGODB_DB.");
  const runId = randomUUID().replaceAll("-", "");
  const started = Date.now();
  const events: TraceEvent[] = [];
  function emit(event: EventPayload): void {
    const trace = { ...event, sequence: events.length + 1 };
    events.push(trace);
    options.onEvent?.(trace);
  }
  const names = [...new Set([collectionName(runId, options.scope, "reader"), collectionName(runId, options.scope, "cleaner")])];
  const cleanupClient = new MongoClient(uri, { appName: "ci-memory-demo-runner", maxPoolSize: 2, serverSelectionTimeoutMS: 8_000, connectTimeoutMS: 5_000, timeoutMS: 10_000 });
  const workers: FixtureWorker[] = [];
  const createdNames: string[] = [];
  let passed = false;
  try {
    await cleanupClient.connect();
    for (const name of names) {
      assertOwnedCollection(runId, name);
      await cleanupClient.db(database).createCollection(name);
      createdNames.push(name);
    }
    const recordId = options.scenario === "orders" ? "order-204" : "customer-101";
    const recordLabel = options.scenario === "orders" ? "Order awaiting dispatch" : "Billing customer";
    for (const workerId of ["reader", "cleaner"] as const) {
      const fixture: Fixture = { scenario: options.scenario, recordId, recordLabel, seedEnabled: options.scenario !== "missing-seed", collection: collectionName(runId, options.scope, workerId) };
      workers.push(new FixtureWorker({ uri, database, runId, workerId, fixture }, emit));
    }
    const reader = workers[0]!;
    const cleaner = workers[1]!;
    await Promise.all([reader.ready, cleaner.ready]);
    if (schedule === "cleanup-before-write") await cleaner.command("cleanup");
    await reader.command("insert");
    if (schedule === "cleanup-between-write-and-read") await cleaner.command("cleanup");
    passed = await reader.command("read");
  } finally {
    await Promise.allSettled(workers.map(worker => worker.stop()));
    try {
      for (const name of createdNames) {
        assertOwnedCollection(runId, name);
        try { await cleanupClient.db(database).collection(name).drop(); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === 26)) throw new Error("Demo collection cleanup failed. Check your MongoDB connection.");
        }
      }
      if (createdNames.length) emit({ at: new Date().toISOString(), workerId: "runner", operation: "collections_removed", message: "Removed only this run's temporary collections." });
    } finally { await cleanupClient.close(); }
  }
  return { runId, scenario: options.scenario, scope: options.scope, schedule, status: passed ? "passed" : "failed", startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, events, isolation: "temporary_collections", cleanup: "completed" };
}
