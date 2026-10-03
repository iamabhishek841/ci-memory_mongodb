import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { SavedRun, RunContext } from "./run-store.js";
import { environmentContract, type RepairPlan } from "./repair-plan.js";

export interface Skill extends RunContext {
  _id: string; version: 1; signature: string; environment: string; status: "active" | "revoked";
  title: string; action: RepairPlan["action"]; rationale: string; sourceRunId: string; verifiedRunId: string;
  createdAt: string; expiresAt: string; markdown: string;
}
export interface Investigation extends RunContext {
  _id: string; runId: string; source: "gemini" | "memory"; model: string | null; status: "verified" | "rejected";
  plan: RepairPlan; signature: string; verificationRunId: string | null; skillId: string | null;
  rejectedSkills: Array<{ skillId: string; title: string; reason: string }>; createdAt: string;
}

export class MemoryStore {
  private readonly skills: Collection<Skill>;
  private readonly investigations: Collection<Investigation>;
  constructor(database: Db, readonly context: RunContext, prefix = "") {
    this.skills = database.collection<Skill>(`${prefix}skills`);
    this.investigations = database.collection<Investigation>(`${prefix}investigations`);
  }
  async initialize(): Promise<void> {
    await this.skills.createIndex({ teamId: 1, repositoryId: 1, environment: 1, signature: 1, status: 1 });
    await this.investigations.createIndex({ teamId: 1, repositoryId: 1, runId: 1, createdAt: -1 });
  }
  async listSkills(): Promise<Skill[]> {
    return this.skills.find({ ...this.context }).sort({ createdAt: -1 }).limit(50).toArray();
  }
  async candidates(): Promise<Skill[]> {
    return this.skills.find({ ...this.context, environment: environmentContract, status: "active", expiresAt: { $gt: new Date().toISOString() } }).sort({ createdAt: -1 }).limit(50).toArray();
  }
  async getSkill(id: string): Promise<Skill | null> { return this.skills.findOne({ ...this.context, _id: id }); }
  async revoke(id: string): Promise<boolean> { return (await this.skills.updateOne({ ...this.context, _id: id }, { $set: { status: "revoked" } })).matchedCount === 1; }
  async latest(runId: string): Promise<Investigation | null> { return this.investigations.find({ ...this.context, runId }).sort({ createdAt: -1, _id: -1 }).limit(1).next(); }
  async saveInvestigation(value: Omit<Investigation, keyof RunContext | "_id" | "createdAt">): Promise<Investigation> {
    const document: Investigation = { ...value, ...this.context, _id: randomUUID().replaceAll("-", ""), createdAt: new Date().toISOString() };
    await this.investigations.insertOne(document);
    return document;
  }
  async saveSkill(signature: string, plan: RepairPlan, baseline: SavedRun, verified: SavedRun): Promise<Skill> {
    const title = plan.action === "isolate_workers" ? "Isolate MongoDB test workers" : "Restore fixture seed and isolate workers";
    const document: Skill = {
      ...this.context, _id: randomUUID().replaceAll("-", ""), version: 1, signature, environment: environmentContract, status: "active",
      title, action: plan.action, rationale: plan.rationale, sourceRunId: baseline.runId, verifiedRunId: verified.runId,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), markdown: "",
    };
    document.markdown = `---\nname: ${title}\nversion: 1\nsignature: ${signature}\nenvironment: ${environmentContract}\n---\n\n# ${title}\n\n${plan.rationale}\n\n## Applicability\n\nUse only for signature ${signature} in team ${this.context.teamId}, repository ${this.context.repositoryId}. Match ordered operations, not the error message alone. Expires ${document.expiresAt}.\n\n## Bounded repair\n\nAction: ${plan.action}. Preserve insert-cleanup-read scheduling during verification. Do not remove assertions or skip cleanup.\n\n## Verified evidence\n\nBaseline: ${baseline.runId}; cited events: ${plan.evidenceSequences.join(", ")}.\nVerification: ${verified.runId}; assertion passed; temporary collections removed.\n\nAlways rerun the target fixture. Revoke this skill if its assumptions are no longer correct.\n`;
    await this.skills.insertOne(document);
    return document;
  }
}
