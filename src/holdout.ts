import { createHash } from "node:crypto";

export type Arm = "agent" | "holdout";

export function armScore(leadId: string, salt: string): number {
  return createHash("sha256").update(`${salt}:${leadId}`, "utf8").digest().readUInt32BE(0) / 2 ** 32;
}

export function assignArm(leadId: string, salt: string, holdoutShare: number): Arm {
  if (!(holdoutShare > 0 && holdoutShare < 1)) throw new Error(`holdoutShare must be between 0 and 1, got ${holdoutShare}`);
  if (!salt) throw new Error("a salt is required so a new experiment reshuffles leads");
  return armScore(leadId, salt) < holdoutShare ? "holdout" : "agent";
}
