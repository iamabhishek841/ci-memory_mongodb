import assert from "node:assert/strict";
import test from "node:test";
import { MongoClient } from "mongodb";
import { runFixture } from "./runner.js";

test("real MongoDB operations reproduce interference and verify the scoped fix", { timeout: 120_000 }, async (t) => {
  let baselineId = "";
  await t.test("shared cleanup removes the reader's inserted record", async () => {
    const result = await runFixture({ scenario: "billing", scope: "shared" });
    baselineId = result.runId;
    assert.equal(result.status, "failed");
    assert.equal(result.events.find(e => e.operation === "cleanup")?.deletedCount, 1);
    assert.equal(result.events.find(e => e.operation === "read")?.found, false);
    assert.equal(result.events.find(e => e.operation === "assertion")?.passed, false);
    assert.equal(result.cleanup, "completed");
  });
  await t.test("different scheduling explains why a blind rerun can pass", async () => {
    const result = await runFixture({ scenario: "billing", scope: "shared", schedule: "cleanup-before-write" });
    assert.equal(result.status, "passed");
  });
  await t.test("worker isolation preserves records in both supported modules", async () => {
    for (const scenario of ["billing", "orders"] as const) {
      const result = await runFixture({ scenario, scope: "worker" });
      assert.equal(result.status, "passed");
      assert.equal(result.events.find(e => e.operation === "cleanup")?.deletedCount, 0);
      assert.equal(result.events.find(e => e.operation === "read")?.found, true);
    }
  });
  await t.test("the same null-record assertion from a missing seed is not fixed by isolation", async () => {
    for (const scope of ["shared", "worker"] as const) {
      const result = await runFixture({ scenario: "missing-seed", scope });
      assert.equal(result.status, "failed");
      assert.equal(result.events.find(e => e.operation === "cleanup")?.deletedCount, 0);
      assert.ok(result.events.some(e => e.operation === "seed_skipped"));
    }
  });
  await t.test("temporary collections are removed and concurrent runs do not interfere", async () => {
    const runs = await Promise.all([runFixture({ scenario: "billing", scope: "shared" }), runFixture({ scenario: "orders", scope: "worker" })]);
    assert.notEqual(runs[0]!.runId, runs[1]!.runId);
    assert.deepEqual(runs.map(r => r.status), ["failed", "passed"]);
    const client = new MongoClient(process.env.MONGODB_URI!, { serverSelectionTimeoutMS: 8_000, timeoutMS: 10_000 });
    try {
      await client.connect();
      const collections = await client.db(process.env.MONGODB_DB || "ci_memory").listCollections({}, { nameOnly: true }).toArray();
      for (const id of [baselineId, ...runs.map(r => r.runId)]) {
        assert.ok(!collections.some(c => c.name.startsWith(`ci_memory_demo_${id}_`)));
      }
    } finally { await client.close(); }
  });
});
