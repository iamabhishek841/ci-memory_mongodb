import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { MongoClient } from "mongodb";
import { getDatabaseConfig } from "./config.js";
import { createApiServer } from "./http.js";
import { RunService } from "./run-service.js";
import { RunStore, type SavedRun } from "./run-store.js";

test("Atlas history preserves evidence, scopes access, and compares actual runs", { timeout: 120_000 }, async (t) => {
  const config = getDatabaseConfig();
  assert.ok(config, "Configure the root .env for Atlas integration checks.");
  const name = `ci_memory_history_test_${randomUUID().replaceAll("-", "")}`;
  const context = { teamId: "integration-test", repositoryId: "fixtures/billing" };
  const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 8_000, timeoutMS: 10_000 });
  await client.connect();
  const database = client.db(config.name);
  const store = new RunStore(database, context, name);
  await store.initialize();
  let currentService = new RunService(store);
  const server = createApiServer(async () => currentService);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const created: SavedRun[] = [];
  async function execute(scenario: string, scope: string): Promise<SavedRun> {
    const response = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scenario, scope }) });
    assert.equal(response.status, 201);
    const result = await response.json() as SavedRun;
    assert.equal(response.headers.get("location"), `/runs/${result.runId}`);
    return result;
  }
  try {
    await t.test("HTTP execution durably stores the failure and independently checked fix", async () => {
      created.push(await execute("billing", "shared"), await execute("billing", "worker"));
      assert.deepEqual(created.map(run => run.status), ["failed", "passed"]);
      assert.equal(created[0]!.events.find(e => e.operation === "cleanup")?.deletedCount, 1);
      assert.equal(created[1]!.events.find(e => e.operation === "read")?.found, true);
      assert.equal(await database.collection(name).countDocuments(context), 2);
      for (const run of created) {
        assert.equal(run.teamId, context.teamId);
        assert.equal(run.repositoryId, context.repositoryId);
        assert.ok(!JSON.stringify(run).includes(config.uri));
      }
      await assert.rejects(store.save(created[0]!), error => error instanceof Error && "code" in error && error.code === 11000);
    });
    await t.test("a fresh connection and service recover the full ordered evidence", async () => {
      const reopened = new MongoClient(config.uri, { serverSelectionTimeoutMS: 8_000, timeoutMS: 10_000 });
      try {
        await reopened.connect();
        currentService = new RunService(new RunStore(reopened.db(config.name), context, name));
        const response = await fetch(`${base}/runs/${created[0]!.runId}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), created[0]);
      } finally { currentService = new RunService(store); await reopened.close(); }
    });
    await t.test("bounded keyset pages and filters return stable summaries without traces", async () => {
      const firstResponse = await fetch(`${base}/runs?limit=1`);
      const first = await firstResponse.json() as { runs: SavedRun[]; nextCursor: string };
      assert.equal(first.runs.length, 1);
      assert.equal(first.runs[0]!.runId, created[1]!.runId);
      assert.ok(!("events" in first.runs[0]!));
      const secondResponse = await fetch(`${base}/runs?limit=1&cursor=${first.nextCursor}`);
      const second = await secondResponse.json() as { runs: SavedRun[]; nextCursor: null };
      assert.equal(second.runs[0]!.runId, created[0]!.runId);
      assert.equal(second.nextCursor, null);
      const filtered = await (await fetch(`${base}/runs?status=passed&scope=worker`)).json() as { runs: SavedRun[] };
      assert.deepEqual(filtered.runs.map(run => run.runId), [created[1]!.runId]);
      assert.equal((await fetch(`${base}/runs?status=passed&cursor=${created[0]!.runId}`)).status, 400);
    });
    await t.test("another team or repository cannot read or count this evidence", async () => {
      for (const other of [{ ...context, teamId: "other-team" }, { ...context, repositoryId: "fixtures/orders" }]) {
        const scoped = new RunStore(database, other, name);
        assert.equal(await scoped.get(created[0]!.runId), null);
        assert.deepEqual((await scoped.list({ limit: 20 })).runs, []);
        assert.deepEqual(await scoped.summary(), []);
        await assert.rejects(scoped.list({ limit: 20, cursor: created[0]!.runId }), RequestErrorCheck);
      }
    });
    await t.test("aggregation includes the failed unrelated cause without claiming a fix", async () => {
      const missingSeed = await execute("missing-seed", "worker");
      assert.equal(missingSeed.status, "failed");
      const response = await fetch(`${base}/runs/summary`);
      assert.equal(response.status, 200);
      const { groups } = await response.json() as { groups: Array<{ scenario: string; scope: string; status: string; count: number; averageDurationMs: number }> };
      assert.deepEqual(groups.map(({ averageDurationMs: _duration, ...group }) => group), [
        { scenario: "billing", scope: "shared", status: "failed", count: 1 },
        { scenario: "billing", scope: "worker", status: "passed", count: 1 },
        { scenario: "missing-seed", scope: "worker", status: "failed", count: 1 },
      ]);
      assert.ok(groups.every(group => group.averageDurationMs > 0));
      assert.equal((await fetch(`${base}/runs/${"0".repeat(32)}`)).status, 404);
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    try { await database.collection(name).drop(); } finally { await client.close(); }
  }
});

function RequestErrorCheck(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 400;
}
