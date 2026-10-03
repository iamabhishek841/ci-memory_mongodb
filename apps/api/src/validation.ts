import { scenarios, type Scenario, type Schedule, type Scope } from "@ci-memory/runner/types";

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface FixtureRequest { scenario: Scenario; scope: Scope; schedule: Schedule; }
export interface HistoryQuery {
  limit: number;
  cursor?: string;
  scenario?: Scenario;
  scope?: Scope;
  status?: "passed" | "failed";
}

export function parseFixtureRequest(value: unknown): FixtureRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "Expected a JSON object.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["scenario", "scope", "schedule"].includes(key))) throw new RequestError(400, "Unsupported request field.");
  if (!scenarios.includes(body.scenario as Scenario)) throw new RequestError(400, "Choose billing, orders, or missing-seed.");
  if (body.scope !== "shared" && body.scope !== "worker") throw new RequestError(400, "Choose shared or worker collection scope.");
  const schedule = body.schedule ?? "cleanup-between-write-and-read";
  if (schedule !== "cleanup-between-write-and-read" && schedule !== "cleanup-before-write") throw new RequestError(400, "Unsupported fixture schedule.");
  return { scenario: body.scenario as Scenario, scope: body.scope, schedule };
}

export function isRunId(value: string): boolean { return /^[a-f0-9]{32}$/.test(value); }

export function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
  for (const key of params.keys()) {
    if (!["limit", "cursor", "scenario", "scope", "status"].includes(key) || params.getAll(key).length !== 1) throw new RequestError(400, "Unsupported or repeated query parameter.");
  }
  const limit = params.get("limit") ?? "20";
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50) throw new RequestError(400, "Limit must be an integer from 1 to 50.");
  const result: HistoryQuery = { limit: Number(limit) };
  const cursor = params.get("cursor");
  if (cursor !== null) {
    if (!isRunId(cursor)) throw new RequestError(400, "Invalid run cursor.");
    result.cursor = cursor;
  }
  const scenario = params.get("scenario");
  if (scenario !== null) {
    if (!scenarios.includes(scenario as Scenario)) throw new RequestError(400, "Unsupported scenario filter.");
    result.scenario = scenario as Scenario;
  }
  const scope = params.get("scope");
  if (scope !== null) {
    if (scope !== "shared" && scope !== "worker") throw new RequestError(400, "Unsupported scope filter.");
    result.scope = scope;
  }
  const status = params.get("status");
  if (status !== null) {
    if (status !== "passed" && status !== "failed") throw new RequestError(400, "Unsupported status filter.");
    result.status = status;
  }
  return result;
}
