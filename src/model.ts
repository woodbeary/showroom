import { parseInstant } from "./clock.ts";
import type { Desk } from "./intent.ts";
import { isState, type State } from "./journey.ts";
import type { Store, Vehicle } from "./store.ts";

export type Author = "customer" | "agent" | "staff";

export interface Message {
  from: Author;
  text: string;
  at: string;
}

export interface ModelRequest {
  decidedAt: string;
  sendAt: string;
  leadId: string;
  state: State;
  thread: readonly Message[];
  vehicle: Vehicle | null;
  offeredSlots: readonly string[];
  store: Pick<Store, "timeZone" | "driveHours">;
}

export interface Proposal {
  next: State;
  draft: string | null;
  slots?: string[];
  slot?: string;
  desk?: Desk;
  reason?: string;
}

export interface Model {
  readonly name: string;
  propose(request: ModelRequest): Promise<Proposal>;
}

export function checkRequest(request: ModelRequest): ModelRequest {
  parseInstant(request.decidedAt, "decidedAt");
  parseInstant(request.sendAt, "sendAt");
  return request;
}

export function checkProposal(value: unknown): Proposal {
  const p = value as Proposal;
  if (!p || typeof p !== "object" || !isState(p.next)) throw new Error(`proposal has no valid next state: ${JSON.stringify(value)}`);
  if (p.draft !== null && typeof p.draft !== "string") throw new Error("proposal draft must be a string or null");
  return p;
}

export function scripted(name: string, proposals: readonly Proposal[]): Model {
  let i = 0;
  return {
    name,
    async propose(request) {
      checkRequest(request);
      const p = proposals[i++];
      if (!p) throw new Error(`${name}: no scripted proposal for turn ${i}`);
      return checkProposal(p);
    },
  };
}
