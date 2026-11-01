import { runChecks, type Hold } from "./checks.ts";
import { earliestSend, localTime, minutesOf, parseInstant } from "./clock.ts";
import { readInbound, type Desk, type Reading } from "./intent.ts";
import { canMove, onInbound, type State } from "./journey.ts";
import { checkProposal, checkRequest, type Message, type Model, type Proposal } from "./model.ts";
import { lookupVehicle, type Store, type Vehicle } from "./store.ts";

export type Action = "reply" | "handoff" | "no_reply" | "opt_out";

export type HandoffBy = "trigger" | "check" | "illegal_move" | "model" | "model_error" | "unanswered_ask" | "owner";

export interface Lead {
  id: string;
  stock?: string;
  state: State;
  thread: Message[];
  offeredSlots: string[];
  bookedSlot?: string;
}

export interface Handoff {
  desk: Desk;
  reason: string;
  by: HandoffBy;
}

export interface TurnResult {
  writtenBy: "showroom";
  leadId: string;
  decidedAt: string;
  sendAt: string | null;
  path: State[];
  action: Action;
  text: string | null;
  reading: Reading;
  model: string | null;
  proposal: Proposal | null;
  holds: Hold[];
  handoff: Handoff | null;
}

export interface TurnInput {
  lead: Lead;
  text: string;
  decidedAt: string;
  store: Store;
  inventory: readonly Vehicle[];
  model: Model;
}

export const HANDOFF_COPY = "Good question. I'm getting you the right person for it, and they'll text you from this number.";

const MAX_SLOTS = 3;

function slotProblem(slot: string, sendAt: Date, store: Store): string | null {
  let at: Date;
  try {
    at = parseInstant(slot, "slot");
  } catch {
    return `${slot} is not a time`;
  }
  if (at.getTime() <= sendAt.getTime()) return `${slot} is not after the reply goes out`;
  const t = localTime(at, store.timeZone);
  if (store.driveHours.closedDays.includes(t.weekday)) return `${slot} falls on a closed day`;
  const m = t.hour * 60 + t.minute;
  if (m < minutesOf(store.driveHours.open) || m >= minutesOf(store.driveHours.close)) return `${slot} is outside drive hours`;
  return null;
}

function requirement(current: State, p: Proposal, lead: Lead, vehicle: Vehicle | null, sendAt: Date, store: Store): string | null {
  if (!canMove(current, p.next)) return `${current} -> ${p.next} is not a legal move`;
  if (p.next === "opted_out") return "only the customer's STOP opts a lead out";
  if (p.next === "vehicle_confirmed" && !vehicle) return "no vehicle in inventory for this lead";
  const entering = p.next !== current;
  if (p.next === "drive_offered" && (entering || p.slots !== undefined)) {
    if (!vehicle || vehicle.status !== "available") return `vehicle ${lead.stock ?? "(none)"} is not available to drive`;
    const slots = p.slots ?? [];
    if (slots.length === 0 || slots.length > MAX_SLOTS) return `a drive offer needs 1 to ${MAX_SLOTS} slots`;
    for (const s of slots) {
      const problem = slotProblem(s, sendAt, store);
      if (problem) return problem;
    }
  }
  if (p.next === "booked" && (entering || p.slot !== undefined)) {
    const offered = lead.offeredSlots.map((s) => parseInstant(s, "offered slot").getTime());
    const at = p.slot && /(?:Z|[+-]\d{2}:\d{2})$/.test(p.slot) ? Date.parse(p.slot) : Number.NaN;
    if (!offered.includes(at)) return `booking ${p.slot ?? "(no slot)"} was never offered`;
  }
  return null;
}

function slotsFor(p: Proposal, lead: Lead): Date[] {
  const raw = p.next === "drive_offered" ? (p.slots ?? []) : p.slot ? [p.slot] : lead.bookedSlot ? [lead.bookedSlot] : [];
  return raw.map((s) => parseInstant(s, "slot"));
}

export async function turn(input: TurnInput): Promise<{ result: TurnResult; lead: Lead }> {
  const { store, model } = input;
  const decided = parseInstant(input.decidedAt, "decidedAt");
  const inbound: Message = { from: "customer", text: input.text, at: input.decidedAt };
  const lead: Lead = { ...input.lead, thread: [...input.lead.thread, inbound] };
  const reading = readInbound(input.text);
  const base = {
    writtenBy: "showroom" as const,
    leadId: lead.id,
    decidedAt: input.decidedAt,
    reading,
    model: null as string | null,
    proposal: null as Proposal | null,
    holds: [] as Hold[],
  };

  if (reading.kind === "stop") {
    const path: State[] = lead.state === "opted_out" ? ["opted_out"] : [lead.state, "opted_out"];
    return {
      result: { ...base, sendAt: null, path, action: "opt_out", text: null, handoff: null },
      lead: { ...lead, state: "opted_out" },
    };
  }

  if (lead.state === "opted_out" || lead.state === "handed_off") {
    const reason = lead.state === "opted_out" ? "message_after_opt_out" : reading.kind === "possible_stop" ? "possible_opt_out" : "already_handed_off";
    return {
      result: { ...base, sendAt: null, path: [lead.state], action: "handoff", text: null, handoff: { desk: "salesperson", reason, by: "owner" } },
      lead,
    };
  }

  const path = onInbound(lead.state);
  const current = path[path.length - 1] as State;

  if (reading.kind === "possible_stop") {
    return {
      result: { ...base, sendAt: null, path: [...path, "handed_off"], action: "handoff", text: null, handoff: { desk: "salesperson", reason: "possible_opt_out", by: "trigger" } },
      lead: { ...lead, state: "handed_off" },
    };
  }

  const sendAt = earliestSend(decided, store.quietHours, store.timeZone);

  const handOff = (handoff: Handoff, extra: Partial<TurnResult> = {}) => {
    const text = HANDOFF_COPY;
    return {
      result: { ...base, ...extra, sendAt: sendAt.toISOString(), path: [...path, "handed_off" as State], action: "handoff" as Action, text, handoff },
      lead: { ...lead, state: "handed_off" as State, thread: [...lead.thread, { from: "agent" as const, text, at: sendAt.toISOString() }] },
    };
  };

  if (reading.kind === "handoff" && reading.desk && reading.trigger) {
    return handOff({ desk: reading.desk, reason: reading.trigger, by: "trigger" });
  }

  const vehicle = lookupVehicle(input.inventory, lead.stock);
  let proposal: Proposal;
  try {
    const request = checkRequest({
      decidedAt: input.decidedAt,
      sendAt: sendAt.toISOString(),
      leadId: lead.id,
      state: current,
      thread: lead.thread,
      vehicle,
      offeredSlots: lead.offeredSlots,
      store: { timeZone: store.timeZone, driveHours: store.driveHours },
    });
    proposal = checkProposal(await model.propose(request));
  } catch (error) {
    return handOff({ desk: "salesperson", reason: `model_error: ${(error as Error).message}`, by: "model_error" }, { model: model.name });
  }
  const seen = { model: model.name, proposal };

  if (proposal.next === "handed_off") {
    return handOff({ desk: proposal.desk ?? "salesperson", reason: proposal.reason ?? "model_handoff", by: "model" }, seen);
  }

  const problem = requirement(current, proposal, lead, vehicle, sendAt, store);
  if (problem) return handOff({ desk: "salesperson", reason: problem, by: "illegal_move" }, seen);

  const nextPath = proposal.next === current ? path : [...path, proposal.next];

  if (proposal.draft === null) {
    if (reading.asks) return handOff({ desk: "salesperson", reason: "the customer asked and the model chose silence", by: "unanswered_ask" }, seen);
    return {
      result: { ...base, ...seen, sendAt: null, path: nextPath, action: "no_reply", text: null, handoff: null },
      lead: { ...lead, state: proposal.next },
    };
  }

  const holds = runChecks(proposal.draft, {
    facts: vehicle ? [vehicle] : [],
    slots: slotsFor(proposal, lead),
    decidedAt: decided,
    sendAt,
    optedOut: false,
    store,
  });
  if (holds.length > 0) {
    const first = holds[0] as Hold & { desk: Desk };
    return handOff({ desk: first.desk, reason: first.check, by: "check" }, { ...seen, holds: holds.map(({ check, detail }) => ({ check, detail })) });
  }

  const text = proposal.draft;
  const next: Lead = { ...lead, state: proposal.next, thread: [...lead.thread, { from: "agent", text, at: sendAt.toISOString() }] };
  if (proposal.next === "drive_offered") next.offeredSlots = [...(proposal.slots ?? [])];
  if (proposal.next === "booked" && proposal.slot) next.bookedSlot = proposal.slot;
  return {
    result: { ...base, ...seen, sendAt: sendAt.toISOString(), path: nextPath, action: "reply", text, handoff: null },
    lead: next,
  };
}
