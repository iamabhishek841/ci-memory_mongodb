import { runFixture } from "@ci-memory/runner";
import { proposeRepair } from "./gemini.js";
import { MemoryStore, type Investigation } from "./memory-store.js";
import { applicable, fingerprint, type RepairPlan } from "./repair-plan.js";
import { RunStore } from "./run-store.js";
import { RequestError } from "./validation.js";

type Proposer = (run: Awaited<ReturnType<RunStore["save"]>>) => Promise<{ plan: RepairPlan; model: string }>;
export class InvestigationService {
  private active = false;
  constructor(private readonly runs: RunStore, readonly memory: MemoryStore, private readonly propose: Proposer = proposeRepair) {}
  async investigate(runId: string): Promise<Investigation> {
    if (this.active) throw new RequestError(429, "Another investigation is running. Retry after it completes.");
    this.active = true;
    try {
      const run = await this.runs.get(runId);
      if (!run) throw new RequestError(404, "Run not found in this repository scope.");
      if (run.status !== "failed") throw new RequestError(400, "Select a failing run to investigate.");
      const signature = fingerprint(run);
      const candidates = await this.memory.candidates();
      const matching = candidates.find(skill => skill.signature === signature && applicable(skill.action, signature));
      const rejectedSkills = candidates.filter(skill => !applicable(skill.action, signature) || skill.signature !== signature).map(skill => ({ skillId: skill._id, title: skill.title, reason: "The ordered evidence has a different cause signature; the matching error message is insufficient." }));
      const proposal = matching ? { plan: { action: matching.action, rationale: matching.rationale, evidenceSequences: run.events.filter(event => ["insert", "cleanup", "read", "seed_skipped"].includes(event.operation)).map(event => event.sequence) }, model: null } : await this.propose(run);
      const source = matching ? "memory" : "gemini";
      if (!applicable(proposal.plan.action, signature)) return this.memory.saveInvestigation({ runId, source, model: proposal.model, status: "rejected", plan: proposal.plan, signature, verificationRunId: null, skillId: null, rejectedSkills });
      const repaired = await runFixture({ scenario: run.scenario, scope: "worker", schedule: "cleanup-between-write-and-read", ...(proposal.plan.action === "restore_seed" ? { repair: "restore_seed" as const } : {}) });
      const verification = await this.runs.save(repaired);
      const verified = verification.status === "passed" && verification.cleanup === "completed";
      const skill = verified ? matching || await this.memory.saveSkill(signature, proposal.plan, run, verification) : null;
      return this.memory.saveInvestigation({ runId, source, model: proposal.model, status: verified ? "verified" : "rejected", plan: proposal.plan, signature, verificationRunId: verification.runId, skillId: skill?._id || null, rejectedSkills });
    } finally { this.active = false; }
  }
}
