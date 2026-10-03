import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApiServer } from "./http.js";
import { parseFixtureRequest, parseHistoryQuery, RequestError } from "./validation.js";

test("only authored fixture options can cross the execution boundary", () => {
  assert.deepEqual(parseFixtureRequest({ scenario: "billing", scope: "shared" }), { scenario: "billing", scope: "shared", schedule: "cleanup-between-write-and-read" });
  for (const input of [null, [], { scenario: "billing", scope: { $ne: "worker" } }, { scenario: "billing", scope: "shared", command: "rm -rf" }, { scenario: "orders", scope: "worker", teamId: "other-team" }]) {
    assert.throws(() => parseFixtureRequest(input), RequestError);
  }
});

test("history filters reject unbounded limits, operators, and repeated values", () => {
  for (const query of ["limit=0", "limit=51", "limit=1.5", "limit=1e1", "status[$ne]=failed", "status=passed&status=failed", "cursor=customers"]) {
    assert.throws(() => parseHistoryQuery(new URLSearchParams(query)), RequestError);
  }
  assert.deepEqual(parseHistoryQuery(new URLSearchParams("scenario=orders&status=passed&scope=worker&limit=5")), { limit: 5, scenario: "orders", scope: "worker", status: "passed" });
});

test("invalid HTTP input never starts work and infrastructure errors hide raw secrets", async () => {
  let calls = 0;
  const server = createApiServer(async () => { calls++; throw new Error("mongodb://test-user:private-password@unreachable.invalid"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const invalid = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"scenario":"billing","scope":"shared","command":"run-anything"}' });
    assert.equal(invalid.status, 400);
    const crossOrigin = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com" }, body: '{"scenario":"billing","scope":"shared"}' });
    assert.equal(crossOrigin.status, 403);
    const oversized = await fetch(`${base}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(5000) }) });
    assert.equal(oversized.status, 413);
    assert.equal(calls, 0);
    const unavailable = await fetch(`${base}/runs`);
    assert.equal(unavailable.status, 503);
    const text = await unavailable.text();
    assert.ok(!text.includes("private-password") && !text.includes("mongodb://"));
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
