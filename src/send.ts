import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { CHECKS, runChecks } from "./checks.ts";
import { describe, inQuietHours, parseInstant } from "./clock.ts";
import type { State } from "./journey.ts";
import type { Store } from "./store.ts";
import type { TurnResult } from "./turn.ts";

export type Mode = "shadow" | "live";

export type SendState = "shadowed" | "held" | "sending" | "sent" | "unconfirmed_never_resubmitted";

const FINAL: ReadonlySet<SendState> = new Set(["shadowed", "held", "sent", "unconfirmed_never_resubmitted"]);

export interface LedgerRow {
  writtenBy: "showroom";
  requestId: string;
  leadId: string;
  state: SendState;
  at: string;
  detail: string;
  receipt?: string;
}

export interface Sender {
  send(requestId: string, leadId: string, text: string): Promise<string>;
  lookup(requestId: string): Promise<string | null>;
}

function appendDurably(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export class Ledger {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  latest(): Map<string, LedgerRow> {
    const out = new Map<string, LedgerRow>();
    for (const row of readJsonl<LedgerRow>(this.path)) out.set(row.requestId, row);
    return out;
  }
  write(row: Omit<LedgerRow, "writtenBy">): LedgerRow {
    const full: LedgerRow = { writtenBy: "showroom", ...row };
    appendDurably(this.path, `${JSON.stringify(full)}\n`);
    return full;
  }
}

export function readSwitch(path: string): { on: boolean; why: string } {
  if (!existsSync(path)) return { on: false, why: `${path} is missing` };
  const value = readFileSync(path, "utf8").trim();
  return value === "on" ? { on: true, why: "on" } : { on: false, why: `${path} says '${value}'` };
}

export function requestId(r: Pick<TurnResult, "leadId" | "decidedAt">): string {
  return `${r.leadId}@${r.decidedAt}`;
}

export interface CycleOptions {
  mode: Mode;
  ledger: Ledger;
  switchPath: string;
  sender: Sender | null;
  store: Store;
  now: Date;
}

export interface CycleLine {
  requestId: string;
  outcome: SendState | "not_due" | "quiet_hours" | "done";
  detail: string;
}

const AT_SEND_TIME = CHECKS.filter((c) => c.name === "stop_honored" || c.name === "day_words_match_send_day");

interface LeadNow {
  state: State;
  decidedAt: Date;
  possibleStopAt: Date | null;
}

function leadsAsOf(turns: readonly TurnResult[], now: Date): Map<string, LeadNow> {
  const out = new Map<string, LeadNow>();
  for (const r of turns) {
    const decidedAt = parseInstant(r.decidedAt, "decidedAt");
    const state = r.path[r.path.length - 1];
    if (!state || decidedAt.getTime() > now.getTime()) continue;
    const seen = out.get(r.leadId);
    const latest = !seen || seen.decidedAt.getTime() < decidedAt.getTime() ? { state, decidedAt } : seen;
    const earlierStop = seen?.possibleStopAt ?? null;
    const laterStop = r.reading.kind === "possible_stop" && (!earlierStop || earlierStop.getTime() < decidedAt.getTime());
    out.set(r.leadId, { state: latest.state, decidedAt: latest.decidedAt, possibleStopAt: laterStop ? decidedAt : earlierStop });
  }
  return out;
}

export async function cycle(queue: readonly TurnResult[], o: CycleOptions): Promise<CycleLine[]> {
  const lines: CycleLine[] = [];
  const known = o.ledger.latest();
  const leads = leadsAsOf(queue, o.now);
  const sw = readSwitch(o.switchPath);
  const quiet = inQuietHours(o.now, o.store.quietHours, o.store.timeZone);
  const record = (r: TurnResult, id: string, state: SendState, detail: string, receipt?: string) => {
    o.ledger.write({ requestId: id, leadId: r.leadId, state, at: o.now.toISOString(), detail, ...(receipt ? { receipt } : {}) });
    lines.push({ requestId: id, outcome: state, detail });
  };

  for (const r of queue) {
    if (!r.text || !r.sendAt) continue;
    const id = requestId(r);
    const prev = known.get(id);
    if (prev && FINAL.has(prev.state)) {
      lines.push({ requestId: id, outcome: "done", detail: prev.state });
      continue;
    }
    if (prev?.state === "sending") {
      const receipt = o.sender ? await o.sender.lookup(id) : null;
      if (receipt) record(r, id, "sent", "found by lookup after a lost answer", receipt);
      else record(r, id, "unconfirmed_never_resubmitted", "found in sending at start; lookup has no receipt");
      continue;
    }
    const decidedAt = parseInstant(r.decidedAt, "decidedAt");
    const lead = leads.get(r.leadId);
    const later = lead && lead.decidedAt.getTime() > decidedAt.getTime() ? lead : null;
    const sendAt = parseInstant(r.sendAt, "sendAt");
    const due = sendAt.getTime() <= o.now.getTime();
    const holds = runChecks(r.text, {
      facts: [],
      slots: [],
      decidedAt,
      sendAt: due ? o.now : sendAt,
      optedOut: later?.state === "opted_out",
      store: o.store,
    }, AT_SEND_TIME);
    if (holds.length > 0) {
      record(r, id, "held", holds.map((h) => `${h.check}: ${h.detail}`).join("; "));
      continue;
    }
    if (lead?.possibleStopAt && lead.possibleStopAt.getTime() > decidedAt.getTime()) {
      record(r, id, "held", `possible_opt_out: the customer may have opted out ${describe(lead.possibleStopAt, o.store.timeZone)}; a person decides before anything goes`);
      continue;
    }
    if (later?.state === "handed_off" && r.action !== "handoff") {
      record(r, id, "held", `owner: a person took the lead ${describe(later.decidedAt, o.store.timeZone)}; the reply is theirs`);
      continue;
    }
    if (!due) {
      lines.push({ requestId: id, outcome: "not_due", detail: `goes out ${describe(sendAt, o.store.timeZone)}` });
      continue;
    }
    if (o.mode === "shadow") {
      record(r, id, "shadowed", "shadow mode: logged, never sent");
      continue;
    }
    if (!sw.on) {
      record(r, id, "held", `kill_switch: ${sw.why}; a person takes it`);
      continue;
    }
    if (quiet) {
      lines.push({ requestId: id, outcome: "quiet_hours", detail: "waits for the end of quiet hours" });
      continue;
    }
    if (!o.sender) {
      record(r, id, "held", "live mode without a sender");
      continue;
    }
    o.ledger.write({ requestId: id, leadId: r.leadId, state: "sending", at: o.now.toISOString(), detail: "intent written before the send" });
    try {
      const receipt = await o.sender.send(id, r.leadId, r.text);
      record(r, id, "sent", "receipt", receipt);
    } catch (error) {
      const receipt = await o.sender.lookup(id);
      if (receipt) record(r, id, "sent", "send raised, lookup found the receipt", receipt);
      else record(r, id, "unconfirmed_never_resubmitted", `send raised (${(error as Error).message}); lookup has no receipt`);
    }
  }
  return lines;
}

export type CrashPoint = "before_write" | "after_write";

export class FileSender implements Sender {
  readonly path: string;
  readonly crash: CrashPoint | null;
  constructor(path: string, crash: CrashPoint | null = null) {
    this.path = path;
    this.crash = crash;
  }
  async send(requestId: string, leadId: string, text: string): Promise<string> {
    if (this.crash === "before_write") process.exit(137);
    const receipt = `rcpt-${readJsonl(this.path).length + 1}`;
    appendFileSync(this.path, `${JSON.stringify({ requestId, leadId, text, receipt })}\n`);
    if (this.crash === "after_write") process.exit(137);
    return receipt;
  }
  async lookup(requestId: string): Promise<string | null> {
    const hit = readJsonl<{ requestId: string; receipt: string }>(this.path).find((m) => m.requestId === requestId);
    return hit?.receipt ?? null;
  }
}
