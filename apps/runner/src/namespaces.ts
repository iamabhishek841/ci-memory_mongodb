import type { Scope, WorkerId } from "./types.js";

export function collectionName(runId: string, scope: Scope, worker: WorkerId): string {
  if (!/^[a-f0-9]{32}$/.test(runId)) throw new Error("Invalid demo run identifier.");
  if (scope !== "shared" && scope !== "worker") throw new Error("Invalid collection scope.");
  if (worker !== "reader" && worker !== "cleaner") throw new Error("Invalid worker identifier.");
  return `ci_memory_demo_${runId}_${scope === "shared" ? "shared" : worker}`;
}

export function assertOwnedCollection(runId: string, collection: string): void {
  const allowed = new Set([
    collectionName(runId, "shared", "reader"),
    collectionName(runId, "worker", "reader"),
    collectionName(runId, "worker", "cleaner"),
  ]);
  if (!allowed.has(collection)) throw new Error("Refusing an operation outside this demo run's collections.");
}
