import { runFixture } from "@ci-memory/runner";
import type { RunStore, SavedRun } from "./run-store.js";
import { RequestError, type FixtureRequest } from "./validation.js";
import type { InvestigationService } from "./investigation-service.js";

export class RunService {
  private active = 0;
  constructor(readonly store: RunStore, readonly investigations?: InvestigationService) {}

  async execute(request: FixtureRequest): Promise<SavedRun> {
    if (this.active >= 2) throw new RequestError(429, "Two fixtures are already running. Retry after they finish.");
    this.active++;
    try {
      const result = await runFixture(request);
      return await this.store.save(result);
    } finally { this.active--; }
  }
}
