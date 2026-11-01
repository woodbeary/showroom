import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInstant } from "./clock.ts";
import { DESKS, readInbound, type Desk, type Kind } from "./intent.ts";
import { onInbound, STATES, type State } from "./journey.ts";
import type { Message, Model } from "./model.ts";
import type { Store, Vehicle } from "./store.ts";
import { turn, type Action, type Lead, type TurnResult } from "./turn.ts";

export type Label = Action;
export const ACTIONS: readonly Action[] = ["reply", "handoff", "no_reply", "opt_out"];

export type Source = "customer" | "template" | "staff" | "transfer" | "system" | "agent";

export interface ThreadEvent {
  at: string;
  from: Source;
  text?: string;
  template?: string;
  slots?: string[];
  slot?: string;
  desk?: Desk;
  event?: "opted_out";
}

export interface Thread {
  id: string;
  leadId: string;
  stock?: string;
  observedUntil: string;
  events: ThreadEvent[];
}

export type Unscored = "agent_authored" | "unknown" | "person_owned";

export type Tag = "missed_handoff" | "silent_on_ask" | "extra_handoff" | "extra_message" | "missed_stop" | "false_stop";

export interface Point {
  id: string;
  threadId: string;
  at: string;
  text: string;
  state: State;
  label: Label | null;
  labelDesk: Desk | null;
  unscored: Unscored | null;
  predicted: Action;
  predictedDesk: Desk | null;
  tag: Tag | null;
  result: TurnResult;
}

export const WINDOW_MS = 48 * 60 * 60 * 1000;

const SOURCES: readonly Source[] = ["customer", "template", "staff", "transfer", "system", "agent"];

export type Outcome = { label: Label; desk?: Desk } | { unscored: Unscored };

export function labelAt(thread: Thread, i: number): Outcome {
  const start = parseInstant(thread.events[i]?.at, "event at").getTime();
  const end = start + WINDOW_MS;
  for (let j = i + 1; j < thread.events.length; j++) {
    const e = thread.events[j] as ThreadEvent;
    const at = parseInstant(e.at, "event at").getTime();
    if (at > end) break;
    if (e.from === "customer") return { label: "no_reply" };
    if (e.from === "system" && e.event === "opted_out") return { label: "opt_out" };
    if (e.from === "agent") return { unscored: "agent_authored" };
    if (e.from === "template") return { label: "reply" };
    if (e.from === "staff" || e.from === "transfer") return { label: "handoff", ...(e.desk ? { desk: e.desk } : {}) };
  }
  return parseInstant(thread.observedUntil, "observedUntil").getTime() >= end ? { label: "no_reply" } : { unscored: "unknown" };
}

const TEMPLATE_STATE: Readonly<Record<string, State>> = {
  offer_times: "drive_offered",
  confirm_booking: "booked",
  reminder: "confirmed",
  close: "closed",
};

function afterEvent(lead: Lead, e: ThreadEvent): Lead {
  const thread: Message[] = e.text ? [...lead.thread, { from: e.from === "staff" ? "staff" : "agent", text: e.text, at: e.at }] : lead.thread;
  const next: Lead = { ...lead, thread };
  if (e.from === "system" && e.event === "opted_out") next.state = "opted_out";
  if (e.from === "staff" || e.from === "transfer") next.state = "handed_off";
  if (e.from === "template" || e.from === "agent") {
    const s = e.template ? TEMPLATE_STATE[e.template] : undefined;
    if (s && next.state !== "handed_off" && next.state !== "opted_out") next.state = s;
    if (e.template === "offer_times" && e.slots) next.offeredSlots = [...e.slots];
    if (e.template === "confirm_booking" && e.slot) next.bookedSlot = e.slot;
  }
  return next;
}

export function tagFor(label: Label, predicted: Action): Tag | null {
  if (label === predicted) return null;
  if (label === "opt_out") return "missed_stop";
  if (predicted === "opt_out") return "false_stop";
  if (predicted === "no_reply") return "silent_on_ask";
  if (label === "handoff") return "missed_handoff";
  if (predicted === "handoff") return "extra_handoff";
  return "extra_message";
}

export function validateThread(t: Thread, where: string): Thread {
  if (!t.id || !t.leadId) throw new Error(`${where}: thread needs id and leadId`);
  parseInstant(t.observedUntil, `${where} observedUntil`);
  let last = -Infinity;
  for (const e of t.events) {
    if (!SOURCES.includes(e.from)) throw new Error(`${where}: unknown event source ${JSON.stringify(e.from)}`);
    const at = parseInstant(e.at, `${where} event at`).getTime();
    if (at < last) throw new Error(`${where}: events out of order at ${e.at}`);
    last = at;
  }
  return t;
}

export async function backtestThread(thread: Thread, model: Model, store: Store, inventory: readonly Vehicle[], clock?: () => number): Promise<Point[]> {
  const points: Point[] = [];
  let lead: Lead = { id: thread.leadId, state: "new", thread: [], offeredSlots: [], ...(thread.stock ? { stock: thread.stock } : {}) };
  for (let i = 0; i < thread.events.length; i++) {
    const e = thread.events[i] as ThreadEvent;
    if (e.from !== "customer") {
      lead = afterEvent(lead, e);
      continue;
    }
    const text = e.text ?? "";
    const { result } = await turn({ lead, text, decidedAt: e.at, store, inventory, model, ...(clock ? { clock } : {}) });
    const owned = lead.state === "handed_off" || lead.state === "opted_out";
    const outcome: Outcome = owned ? { unscored: "person_owned" } : labelAt(thread, i);
    const label = "label" in outcome ? outcome.label : null;
    points.push({
      id: `${thread.id}#${i}`,
      threadId: thread.id,
      at: e.at,
      text,
      state: lead.state,
      label,
      labelDesk: "label" in outcome ? (outcome.desk ?? null) : null,
      unscored: "unscored" in outcome ? outcome.unscored : null,
      predicted: result.action,
      predictedDesk: result.action === "handoff" ? (result.handoff?.desk ?? null) : null,
      tag: label ? tagFor(label, result.action) : null,
      result,
    });
    const path = onInbound(lead.state);
    lead = { ...lead, state: path[path.length - 1] as State, thread: [...lead.thread, { from: "customer", text, at: e.at }] };
  }
  return points;
}

export function readThreads(path: string): Thread[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line, n) => [line, n + 1] as const)
    .filter(([line]) => line.trim())
    .map(([line, n]) => validateThread(JSON.parse(line) as Thread, `${path}:${n}`));
}

export interface Fixture {
  id: string;
  text: string;
  origin: string;
  expect: { kind?: Kind; notKind?: Kind; asks?: boolean; action?: Action };
}

export interface FixtureResult {
  fixture: Fixture;
  passed: boolean;
  got: { kind: Kind; asks: boolean; action: Action };
}

export async function runFixtures(fixtures: readonly Fixture[], model: Model, store: Store, vehicle: Vehicle): Promise<FixtureResult[]> {
  const out: FixtureResult[] = [];
  for (const f of fixtures) {
    const reading = readInbound(f.text);
    const lead: Lead = { id: `fixture-${f.id}`, stock: vehicle.stock, state: "engaged", thread: [], offeredSlots: [] };
    const { result } = await turn({ lead, text: f.text, decidedAt: "2026-10-14T10:00:00-07:00", store, inventory: [vehicle], model });
    const got = { kind: reading.kind, asks: reading.asks, action: result.action };
    const x = f.expect;
    const passed =
      (x.kind === undefined || x.kind === got.kind) &&
      (x.notKind === undefined || x.notKind !== got.kind) &&
      (x.asks === undefined || x.asks === got.asks) &&
      (x.action === undefined || x.action === got.action);
    out.push({ fixture: f, passed, got });
  }
  return out;
}

export const NO_HANDOFF = "no_handoff";

export type Routed = Desk | typeof NO_HANDOFF;

export interface Routing {
  named: number;
  agree: number;
  unnamed: number;
  byDesk: { desk: Desk; n: number; agree: number }[];
  confusion: Record<Desk, Record<Routed, number>>;
}

export function routing(scored: readonly Point[]): Routing {
  const routed: readonly Routed[] = [...DESKS, NO_HANDOFF];
  const confusion = Object.fromEntries(DESKS.map((d) => [d, Object.fromEntries(routed.map((r) => [r, 0]))])) as Routing["confusion"];
  const handoffs = scored.filter((p) => p.label === "handoff");
  const named = handoffs.filter((p) => p.labelDesk !== null);
  for (const p of named) confusion[p.labelDesk as Desk][p.predictedDesk ?? NO_HANDOFF]++;
  const byDesk = DESKS.map((desk) => {
    const here = named.filter((p) => p.labelDesk === desk);
    return { desk, n: here.length, agree: here.filter((p) => p.predictedDesk === desk).length };
  }).filter((r) => r.n > 0);
  return {
    named: named.length,
    agree: named.filter((p) => p.predictedDesk === p.labelDesk).length,
    unnamed: handoffs.length - named.length,
    byDesk,
    confusion,
  };
}

export interface ModelCalls {
  timed: number;
  errors: number;
  firstError: string | null;
  p95LatencyMs: number | null;
}

export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] ?? null;
}

export function modelCalls(points: readonly Point[]): ModelCalls {
  const timed = points.filter((p) => p.result.latencyMs !== null);
  const errors = timed.filter((p) => p.result.handoff?.by === "model_error");
  return {
    timed: timed.length,
    errors: errors.length,
    firstError: errors[0]?.result.handoff?.reason ?? null,
    p95LatencyMs: p95(timed.map((p) => p.result.latencyMs as number)),
  };
}

export interface Report {
  threads: number;
  points: Point[];
  scored: Point[];
  unscored: Record<Unscored, number>;
  confusion: Record<Label, Record<Action, number>>;
  byState: { state: State; n: number; agree: number; tags: Partial<Record<Tag, number>> }[];
  tags: Partial<Record<Tag, Point[]>>;
  routing: Routing;
  modelCalls: ModelCalls;
  held: number;
  fixtures: FixtureResult[];
}

export function summarize(threads: number, points: Point[], fixtures: FixtureResult[]): Report {
  const scored = points.filter((p) => p.label !== null);
  const unscored = { agent_authored: 0, unknown: 0, person_owned: 0 };
  for (const p of points) if (p.unscored) unscored[p.unscored]++;
  const confusion = Object.fromEntries(ACTIONS.map((l) => [l, Object.fromEntries(ACTIONS.map((a) => [a, 0]))])) as Report["confusion"];
  const tags: Report["tags"] = {};
  for (const p of scored) {
    confusion[p.label as Label][p.predicted]++;
    if (p.tag) (tags[p.tag] ??= []).push(p);
  }
  const byState = STATES.map((state) => {
    const here = scored.filter((p) => p.state === state);
    const t: Partial<Record<Tag, number>> = {};
    for (const p of here) if (p.tag) t[p.tag] = (t[p.tag] ?? 0) + 1;
    return { state, n: here.length, agree: here.filter((p) => !p.tag).length, tags: t };
  }).filter((r) => r.n > 0);
  const held = points.filter((p) => p.result.holds.length > 0).length;
  return { threads, points, scored, unscored, confusion, byState, tags, routing: routing(scored), modelCalls: modelCalls(points), held, fixtures };
}

export function loadBacktestDir(dir: string): { threads: Thread[]; fixtures: Fixture[] } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f !== "regressions.jsonl").sort();
  const threads = files.flatMap((f) => readThreads(join(dir, f)));
  const fx = join(dir, "regressions.jsonl");
  const fixtures = existsSync(fx)
    ? readFileSync(fx, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Fixture)
    : [];
  return { threads, fixtures };
}

const GATE_ACTION: Readonly<Record<Action, "approve" | "hold" | "skip">> = {
  reply: "approve",
  handoff: "hold",
  no_reply: "skip",
  opt_out: "skip",
};

export function gateExport(points: readonly Point[], fingerprint: string, loggedAt: string): { shadow: object[]; labels: object[] } {
  const shadow = points.map((p) => ({
    mode: "shadow",
    id: p.id,
    decidedAt: p.at,
    action: GATE_ACTION[p.predicted],
    reason: p.result.handoff?.reason ?? p.result.reading.kind,
    confidence: null,
    model: { action: GATE_ACTION[p.predicted], path: p.result.path },
    latency_s: p.result.latencyMs === null ? null : p.result.latencyMs / 1000,
    error: p.result.handoff?.by === "model_error" ? p.result.handoff.reason : null,
    fingerprint,
    loggedAt,
  }));
  const labels = points
    .filter((p) => p.label !== null)
    .map((p) => ({
      id: p.id,
      decidedAt: p.at,
      capturedAt: p.at,
      request: { text: p.text, state: p.state },
      decision: { action: p.label === "reply" ? "approve" : "skip", decidedBy: "human", basis: "content", reason: p.label },
    }));
  return { shadow, labels };
}
