import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { MongoClient } from "mongodb";
import { assertOwnedCollection } from "./namespaces.js";
import type { Command, EventPayload, WorkerConfig, WorkerMessage } from "./types.js";

const config = workerData as WorkerConfig;
const port = parentPort;
if (!port) throw new Error("The fixture must be started by the demo runner.");
assertOwnedCollection(config.runId, config.fixture.collection);

const client = new MongoClient(config.uri, {
  appName: "ci-memory-demo-worker",
  maxPoolSize: 2,
  serverSelectionTimeoutMS: 8_000,
  connectTimeoutMS: 5_000,
  timeoutMS: 10_000,
});

function send(message: WorkerMessage): void { port!.postMessage(message); }
function event(payload: Omit<EventPayload, "workerId" | "at">): void {
  send({ type: "event", event: { ...payload, at: new Date().toISOString(), workerId: config.workerId, collection: config.fixture.collection } });
}

try {
  await client.connect();
  event({ operation: "connected" });
  send({ type: "ready" });
} catch {
  send({ type: "error", message: "Fixture worker could not connect to MongoDB. Check local database configuration." });
  await client.close();
  port.close();
}

let running = false;
port.on("message", (message: { commandId: number; command: Command }) => {
  if (running) {
    send({ type: "error", commandId: message.commandId, message: "Fixture worker already has an active command." });
    return;
  }
  running = true;
  void execute(message.command).then(
    (passed) => {
      send({ type: "complete", commandId: message.commandId, passed });
      if (message.command === "stop") port.close();
    },
    () => send({ type: "error", commandId: message.commandId, message: "Fixture database operation failed. Credential details are omitted." }),
  ).finally(() => { running = false; });
});

async function execute(command: Command): Promise<boolean> {
  const fixture = config.fixture;
  const collection = client.db(config.database).collection<{ _id: string; label: string }>(fixture.collection);
  assertOwnedCollection(config.runId, fixture.collection);
  if (command === "insert") {
    assert.equal(config.workerId, "reader");
    if (fixture.seedEnabled) {
      await collection.insertOne({ _id: fixture.recordId, label: fixture.recordLabel });
      event({ operation: "insert", recordId: fixture.recordId });
    } else {
      event({ operation: "seed_skipped", recordId: fixture.recordId, message: "This fixture omits its required seed step." });
    }
  } else if (command === "cleanup") {
    assert.equal(config.workerId, "cleaner");
    const result = await collection.deleteMany({});
    event({ operation: "cleanup", deletedCount: result.deletedCount });
  } else if (command === "read") {
    assert.equal(config.workerId, "reader");
    const record = await collection.findOne({ _id: fixture.recordId });
    event({ operation: "read", recordId: fixture.recordId, found: record !== null });
    try {
      assert.ok(record, "Expected fixture record to exist, received null.");
      assert.equal(record.label, fixture.recordLabel, "Fixture record value changed.");
      event({ operation: "assertion", passed: true, message: "Record exists and its value is preserved." });
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      event({ operation: "assertion", passed: false, message: error.message });
      return false;
    }
  } else if (command === "stop") {
    await client.close();
  } else {
    throw new Error("Unsupported fixture command.");
  }
  return true;
}
