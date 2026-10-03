import assert from "node:assert/strict";
import test from "node:test";
import { assertOwnedCollection, collectionName } from "./namespaces.js";

const runId = "a".repeat(32);
test("shared workers intentionally address the same owned collection", () => {
  assert.equal(collectionName(runId, "shared", "reader"), collectionName(runId, "shared", "cleaner"));
});
test("worker and run boundaries prevent cleanup crossing another worker or run", () => {
  const reader = collectionName(runId, "worker", "reader");
  const cleaner = collectionName(runId, "worker", "cleaner");
  assert.notEqual(reader, cleaner);
  assertOwnedCollection(runId, reader);
  assert.throws(() => assertOwnedCollection("b".repeat(32), reader));
  assert.throws(() => assertOwnedCollection(runId, "customers"));
  assert.throws(() => assertOwnedCollection(runId, "sample_mflix"));
});
test("collection identifiers reject external names and malformed run IDs", () => {
  assert.throws(() => collectionName("../../customers", "shared", "reader"));
  assert.throws(() => collectionName(runId, "other" as "shared", "reader"));
});
