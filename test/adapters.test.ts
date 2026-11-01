import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { backtestThread, gateExport, modelCalls, p95, type Thread } from "../src/backtest.ts";
import { claudeModel } from "../src/claude.ts";
import { openaiModel } from "../src/openai.ts";
import { routineModel } from "../src/standin.ts";
import { fromStructured, INSTRUCTIONS, PROPOSAL_FIELDS, PROPOSAL_SCHEMA } from "../src/structured.ts";
import { HANDOFF_COPY, turn, type Lead } from "../src/turn.ts";
import { crossover, inventory, store } from "./helpers.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(...replies: unknown[]) {
  const calls: Call[] = [];
  let i = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    const reply = replies[Math.min(i++, replies.length - 1)];
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const NOON = "2026-11-05T12:00:00-08:00";
const SLOTS = ["2026-11-05T17:30:00-08:00", "2026-11-05T18:15:00-08:00"];
const DRAFT = "It's here and ready to drive. I can have it up front Thursday at 5:30 pm or 6:15 pm. Which works better?";
const OFFER = { next: "drive_offered", draft: DRAFT, slots: SLOTS, slot: null, desk: null, reason: null };
const fresh = (): Lead => ({ id: "lead-a", stock: crossover.stock, state: "new", thread: [], offeredSlots: [] });

const claudeReply = (over: Record<string, unknown> = {}, output: unknown = OFFER) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: JSON.stringify(output) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 900, output_tokens: 120 },
  ...over,
});

const openaiReply = (over: Record<string, unknown> = {}, content: unknown[] = [{ type: "output_text", text: JSON.stringify(OFFER), annotations: [] }]) => ({
  id: "resp_test",
  object: "response",
  created_at: 1_793_000_000,
  status: "completed",
  model: "test-model",
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content }],
  incomplete_details: null,
  error: null,
  usage: { input_tokens: 900, output_tokens: 120, total_tokens: 1020 },
  ...over,
});

const claude = (...replies: unknown[]) => {
  const f = fakeFetch(...replies);
  return { ...f, model: claudeModel({ client: new Anthropic({ apiKey: "test-key-not-real", fetch: f.fetch, maxRetries: 0 }) }) };
};

const openai = (...replies: unknown[]) => {
  const f = fakeFetch(...replies);
  return { ...f, model: openaiModel({ client: new OpenAI({ apiKey: "test-key-not-real", fetch: f.fetch, maxRetries: 0 }), model: "test-model" }) };
};

const ask = (model: Parameters<typeof turn>[0]["model"], clock?: () => number) =>
  turn({ lead: fresh(), text: "is it still there? can I see it after work?", decidedAt: NOON, store, inventory, model, ...(clock ? { clock } : {}) });

const schemaText = JSON.stringify(PROPOSAL_SCHEMA);

test("the schema makes every field required, the optional ones nullable, and carries no constraint either provider rejects", () => {
  assert.deepEqual([...PROPOSAL_SCHEMA.required].sort(), [...PROPOSAL_FIELDS].sort());
  assert.deepEqual(Object.keys(PROPOSAL_SCHEMA.properties).sort(), [...PROPOSAL_FIELDS].sort());
  assert.equal(PROPOSAL_SCHEMA.additionalProperties, false);
  for (const field of PROPOSAL_FIELDS.filter((f) => f !== "next")) {
    assert.deepEqual(PROPOSAL_SCHEMA.properties[field].anyOf[1], { type: "null" }, field);
  }
  for (const word of ["minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "format"]) {
    assert.equal(schemaText.includes(`"${word}"`), false, word);
  }
});

test("null comes back as an absent field, and a desk or slot of the wrong kind is refused", () => {
  assert.deepEqual(fromStructured({ next: "engaged", draft: "Hi.", slots: null, slot: null, desk: null, reason: null }), { next: "engaged", draft: "Hi." });
  assert.deepEqual(fromStructured(OFFER), { next: "drive_offered", draft: DRAFT, slots: SLOTS });
  assert.throws(() => fromStructured({ ...OFFER, next: "handed_off", desk: "lot_attendant" }), /desk is not one of/);
  assert.throws(() => fromStructured({ ...OFFER, slots: [1730] }), /slots must be strings/);
  assert.throws(() => fromStructured({ ...OFFER, next: "sold" }), /no valid next state/);
});

test("the Claude adapter sends output_config.format with the schema, and its proposal runs the same checks", async () => {
  const c = claude(claudeReply());
  const { result } = await ask(c.model);
  assert.equal(c.calls.length, 1);
  const call = c.calls[0]!;
  assert.match(call.url, /\/v1\/messages$/);
  assert.equal(call.headers["x-api-key"], "test-key-not-real");
  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.system, INSTRUCTIONS);
  assert.deepEqual(call.body.output_config, { effort: "low", format: { type: "json_schema", schema: JSON.parse(schemaText) } });
  for (const absent of ["thinking", "temperature", "top_p", "top_k", "tools", "tool_choice"]) assert.equal(absent in call.body, false, absent);
  const input = JSON.parse(call.body.messages[0].content);
  assert.equal(input.vehicle.price, 31900);
  assert.equal(input.sendAtLocal, "Thu 2026-11-05 12:00 pm");
  assert.equal(input.state, "engaged");
  assert.deepEqual(input.legalMoves, ["qualified", "vehicle_confirmed", "drive_offered", "handed_off", "closed", "engaged"]);
  assert.equal(input.thread.at(-1).text, "is it still there? can I see it after work?");
  assert.equal(result.model, "claude:claude-opus-5-5");
  assert.equal(result.action, "reply");
  assert.equal(result.text, DRAFT);
  assert.deepEqual(result.proposal, { next: "drive_offered", draft: DRAFT, slots: SLOTS });
  const booked = await turn({ lead: { ...fresh(), state: "engaged" }, text: "can I see it?", decidedAt: NOON, store, inventory, model: claude(claudeReply({}, { ...OFFER, next: "booked", slots: null, slot: SLOTS[0] })).model });
  assert.equal(booked.result.handoff?.by, "illegal_move");
});

test("a Claude draft that quotes an unlisted price is held like any other draft", async () => {
  const c = claude(claudeReply({}, { ...OFFER, next: "engaged", slots: null, draft: "We can do 29.9 on it." }));
  const { result } = await turn({ lead: { ...fresh(), state: "engaged" }, text: "is it still there?", decidedAt: NOON, store, inventory, model: c.model });
  assert.equal(result.action, "handoff");
  assert.deepEqual(result.holds.map((h) => h.check), ["price_from_inventory"]);
  assert.equal(result.text, HANDOFF_COPY);
});

test("a Claude refusal or cut-off becomes a model_error handoff", async () => {
  const refused = await ask(claude(claudeReply({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "declined" } })).model);
  assert.equal(refused.result.handoff?.by, "model_error");
  assert.match(refused.result.handoff?.reason ?? "", /^model_error: refusal \(cyber\)$/);
  assert.equal(refused.result.text, HANDOFF_COPY);
  const cut = await ask(claude(claudeReply({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"next":"dri' }] })).model);
  assert.match(cut.result.handoff?.reason ?? "", /^model_error: stopped at max_tokens$/);
});

test("the OpenAI adapter sends a strict json_schema with nullable optional fields, and asks not to store the response", async () => {
  const o = openai(openaiReply());
  const offered = await turn({ lead: { ...fresh(), state: "engaged" }, text: "can I see it after work?", decidedAt: NOON, store, inventory, model: o.model });
  const call = o.calls[0]!;
  assert.match(call.url, /\/responses$/);
  assert.equal(call.headers.authorization, "Bearer test-key-not-real");
  assert.equal(call.body.model, "test-model");
  assert.equal(call.body.instructions, INSTRUCTIONS);
  assert.equal(call.body.store, false);
  assert.deepEqual(call.body.text, { format: { type: "json_schema", name: "proposal", strict: true, schema: JSON.parse(schemaText) } });
  assert.equal(offered.result.model, "openai:test-model");
  assert.equal(offered.result.action, "reply");
  assert.deepEqual(offered.result.proposal, { next: "drive_offered", draft: DRAFT, slots: SLOTS });
});

test("an OpenAI refusal or an incomplete response becomes a model_error handoff", async () => {
  const refused = await ask(openai(openaiReply({}, [{ type: "refusal", refusal: "I can't help with that." }])).model);
  assert.equal(refused.result.handoff?.by, "model_error");
  assert.match(refused.result.handoff?.reason ?? "", /^model_error: refusal: I can't help with that\.$/);
  const cut = await ask(openai(openaiReply({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, [{ type: "output_text", text: '{"next":"dri', annotations: [] }])).model);
  assert.match(cut.result.handoff?.reason ?? "", /^model_error: incomplete: max_output_tokens$/);
});

test("a real model's decision time and errors reach the autonomy-gate export; the stand-in reports none", async () => {
  const thread: Thread = {
    id: "t-a",
    leadId: "L-a",
    stock: crossover.stock,
    observedUntil: "2026-11-10T00:00:00Z",
    events: [
      { at: NOON, from: "customer", text: "hi is it still there?" },
      { at: "2026-11-05T12:10:00-08:00", from: "template", template: "offer_times", slots: SLOTS },
      { at: "2026-11-05T12:20:00-08:00", from: "customer", text: "do you have a second one like it?" },
    ],
  };
  const ticks = [1_000, 2_250, 5_000, 5_400];
  const clock = () => ticks.shift() ?? 0;
  const c = claude(claudeReply(), claudeReply({ content: [], stop_reason: "refusal", stop_details: null }));
  const points = await backtestThread(thread, c.model, store, inventory, clock);
  assert.deepEqual(points.map((p) => p.result.latencyMs), [1250, 400]);
  const { shadow } = gateExport(points, "showroom claude:claude-opus-5-5", NOON) as { shadow: { latency_s: number | null; error: string | null }[] };
  assert.deepEqual(shadow.map((s) => s.latency_s), [1.25, 0.4]);
  assert.deepEqual(shadow.map((s) => s.error), [null, "model_error: refusal"]);
  assert.deepEqual(modelCalls(points), { timed: 2, errors: 1, firstError: "model_error: refusal", p95LatencyMs: 1250 });

  const stand = await backtestThread(thread, routineModel(), store, inventory, clock);
  assert.ok(stand.every((p) => p.result.latencyMs === null));
  assert.deepEqual(modelCalls(stand), { timed: 0, errors: 0, firstError: null, p95LatencyMs: null });
});

test("p95 is the nearest-rank value autonomy-gate uses", () => {
  assert.equal(p95([]), null);
  assert.equal(p95([3]), 3);
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => i + 1)), 95);
});
