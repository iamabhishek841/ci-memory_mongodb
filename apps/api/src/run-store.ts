import type { RunResult } from "@ci-memory/runner/types";
import type { Collection, Db, Filter } from "mongodb";
import { isRunId, RequestError, type HistoryQuery } from "./validation.js";

export interface RunContext { teamId: string; repositoryId: string; }
interface RunDocument extends Omit<RunResult, "runId" | "startedAt">, RunContext {
  _id: string;
  schemaVersion: 1;
  startedAt: Date;
  savedAt: Date;
}
export interface SavedRun extends RunResult, RunContext { schemaVersion: 1; savedAt: string; }
export type RunSummary = Omit<SavedRun, "events">;

export function getRunContext(): RunContext {
  const teamId = process.env.CI_TEAM_ID?.trim() || "hackathon";
  const repositoryId = process.env.CI_REPOSITORY_ID?.trim() || "iamabhishek841/ci-memory_mongodb";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(teamId) || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repositoryId) || repositoryId.length > 160) throw new Error("Invalid server-side run context.");
  return { teamId, repositoryId };
}

function present(document: RunDocument): SavedRun {
  const { _id, startedAt, savedAt, ...data } = document;
  return { ...data, runId: _id, startedAt: startedAt.toISOString(), savedAt: savedAt.toISOString() };
}

export class RunStore {
  private readonly collection: Collection<RunDocument>;
  constructor(database: Db, private readonly context: RunContext, collectionName = "runs") {
    this.collection = database.collection<RunDocument>(collectionName);
  }

  async initialize(): Promise<void> {
    await this.collection.createIndex({ teamId: 1, repositoryId: 1, startedAt: -1, _id: -1 }, { name: "scoped_history" });
    await this.collection.createIndex({ teamId: 1, repositoryId: 1, scenario: 1, scope: 1, status: 1 }, { name: "scoped_comparison" });
  }

  async save(result: RunResult): Promise<SavedRun> {
    if (!isRunId(result.runId)) throw new Error("Invalid run result identifier.");
    const { runId, startedAt, ...data } = result;
    const document: RunDocument = { ...data, ...this.context, _id: runId, schemaVersion: 1, startedAt: new Date(startedAt), savedAt: new Date() };
    // Insert once: the outcome and its complete trace become durable together.
    await this.collection.insertOne(document);
    return present(document);
  }

  async get(runId: string): Promise<SavedRun | null> {
    if (!isRunId(runId)) throw new RequestError(400, "Invalid run identifier.");
    const document = await this.collection.findOne({ ...this.context, _id: runId });
    return document ? present(document) : null;
  }

  async list(query: HistoryQuery): Promise<{ runs: RunSummary[]; nextCursor: string | null }> {
    const filter: Filter<RunDocument> = { ...this.context };
    if (query.scenario) filter.scenario = query.scenario;
    if (query.scope) filter.scope = query.scope;
    if (query.status) filter.status = query.status;
    if (query.cursor) {
      const cursor = await this.collection.findOne({ ...filter, _id: query.cursor }, { projection: { _id: 1, startedAt: 1 } });
      if (!cursor) throw new RequestError(400, "Cursor does not belong to this filtered history.");
      filter.$or = [{ startedAt: { $lt: cursor.startedAt } }, { startedAt: cursor.startedAt, _id: { $lt: cursor._id } }];
    }
    const documents = await this.collection.find(filter, { projection: { events: 0 } }).sort({ startedAt: -1, _id: -1 }).limit(query.limit + 1).toArray();
    const runs = documents.slice(0, query.limit).map(document => {
      const { events: _events, ...summary } = present(document);
      return summary;
    });
    return { runs, nextCursor: documents.length > query.limit ? runs.at(-1)!.runId : null };
  }

  async summary(): Promise<Array<{ scenario: string; scope: string; status: string; count: number; averageDurationMs: number }>> {
    return this.collection.aggregate<{ scenario: string; scope: string; status: string; count: number; averageDurationMs: number }>([
      { $match: this.context },
      { $group: { _id: { scenario: "$scenario", scope: "$scope", status: "$status" }, count: { $sum: 1 }, averageDurationMs: { $avg: "$durationMs" } } },
      { $project: { _id: 0, scenario: "$_id.scenario", scope: "$_id.scope", status: "$_id.status", count: 1, averageDurationMs: { $round: ["$averageDurationMs", 1] } } },
      { $sort: { scenario: 1, scope: 1, status: 1 } },
    ]).toArray();
  }
}
