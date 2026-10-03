export const scenarios = ["billing", "orders", "missing-seed"] as const;
export type Scenario = (typeof scenarios)[number];
export type Scope = "shared" | "worker";
export type Schedule = "cleanup-between-write-and-read" | "cleanup-before-write";
export type WorkerId = "reader" | "cleaner";
export type Command = "insert" | "cleanup" | "read" | "stop";

export interface Fixture {
  scenario: Scenario;
  recordId: string;
  recordLabel: string;
  collection: string;
  seedEnabled: boolean;
}

export interface WorkerConfig {
  uri: string;
  database: string;
  runId: string;
  workerId: WorkerId;
  fixture: Fixture;
}

export interface TraceEvent {
  sequence: number;
  at: string;
  workerId: WorkerId | "runner";
  operation: "connected" | "insert" | "cleanup" | "read" | "assertion" | "seed_skipped" | "collections_removed";
  collection?: string;
  recordId?: string;
  deletedCount?: number;
  found?: boolean;
  passed?: boolean;
  message?: string;
}

export type EventPayload = Omit<TraceEvent, "sequence">;
export interface WorkerMessage {
  type: "ready" | "complete" | "event" | "error";
  commandId?: number;
  event?: EventPayload;
  passed?: boolean;
  message?: string;
}

export interface RunResult {
  repair?: "restore_seed";
  runId: string;
  scenario: Scenario;
  scope: Scope;
  schedule: Schedule;
  status: "passed" | "failed";
  startedAt: string;
  durationMs: number;
  events: TraceEvent[];
  isolation: "temporary_collections";
  cleanup: "completed";
}
