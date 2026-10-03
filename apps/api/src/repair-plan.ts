import type { RunResult } from "@ci-memory/runner/types";

export type RepairAction = "isolate_workers" | "restore_seed" | "none";
export interface RepairPlan { action: RepairAction; rationale: string; evidenceSequences: number[]; }
export const environmentContract = "mongo-authored-record-fixture-v1";

export function fingerprint(run: RunResult): string {
  const read = run.events.find(e => e.operation === "read");
  if (run.status !== "failed" || read?.found !== false) return "unknown";
  if (run.events.some(e => e.operation === "seed_skipped")) return "mongo.missing-seed.v1";
  const insert = run.events.find(e => e.operation === "insert");
  const cleanup = run.events.find(e => e.operation === "cleanup");
  if (insert && cleanup && insert.sequence < cleanup.sequence && cleanup.sequence < read.sequence && insert.collection === cleanup.collection && cleanup.collection === read.collection && (cleanup.deletedCount || 0) > 0) return "mongo.shared-cleanup.v1";
  return "unknown";
}

export function validatePlan(value: unknown, run: RunResult): RepairPlan {
  if (!value || typeof value !== "object") throw new Error("Invalid repair proposal.");
  const plan = value as Record<string, unknown>;
  if (!Object.keys(plan).every(key => ["action", "rationale", "evidenceSequences"].includes(key)) || !["isolate_workers", "restore_seed", "none"].includes(plan.action as string)) throw new Error("Unsupported repair proposal.");
  if (typeof plan.rationale !== "string" || !plan.rationale.trim() || plan.rationale.length > 1500) throw new Error("Invalid repair rationale.");
  if (!Array.isArray(plan.evidenceSequences) || !plan.evidenceSequences.length || plan.evidenceSequences.length > 12 || !plan.evidenceSequences.every(sequence => Number.isInteger(sequence) && run.events.some(event => event.sequence === sequence))) throw new Error("Repair proposal cites missing evidence.");
  return { action: plan.action as RepairAction, rationale: plan.rationale, evidenceSequences: plan.evidenceSequences as number[] };
}

export function applicable(action: RepairAction, signature: string): boolean {
  return (action === "isolate_workers" && signature === "mongo.shared-cleanup.v1") || (action === "restore_seed" && signature === "mongo.missing-seed.v1");
}
