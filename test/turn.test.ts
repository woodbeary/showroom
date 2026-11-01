import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runChecks } from "../src/checks.ts";
import { checkRequest, scripted, type Model, type ModelRequest, type Proposal } from "../src/model.ts";
import { HANDOFF_COPY, turn, type Lead } from "../src/turn.ts";
import { crossover, EX, inventory, ROOT, store } from "./helpers.ts";

const fresh = (over: Partial<Lead> = {}): Lead => ({ id: "lead-t", stock: crossover.stock, state: "new", thread: [], offeredSlots: [], ...over });
const NOON = "2026-11-05T12:00:00-08:00";

function spy(proposal: Proposal | Error): Model & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    name: "spy",
    calls,
    async propose(r) {
      calls.push(r);
      if (proposal instanceof Error) throw proposal;
      return proposal;
    },
  };
}

test("the 9:52 pm lead: offered two times, booked, then a payment draft held for the finance desk", async () => {
  const spec = JSON.parse(readFileSync(join(EX, "lead-0952pm.json"), "utf8"));
  const model = scripted(spec.model, spec.turns.map((t: { proposal: Proposal }) => t.proposal));
  let lead: Lead = spec.lead;
  const results = [];
  for (const t of spec.turns) {
    const out = await turn({ lead, text: t.customer, decidedAt: t.decidedAt, store, inventory, model });
    lead = out.lead;
    results.push(out.result);
  }
  const [one, two, three] = results;
  assert.deepEqual(one!.path, ["new", "engaged", "drive_offered"]);
  assert.equal(one!.action, "reply");
  assert.equal(one!.sendAt, "2026-11-05T16:00:00.000Z");
  assert.deepEqual(two!.path, ["drive_offered", "booked"]);
  assert.equal(three!.action, "handoff");
  assert.deepEqual(three!.handoff, { desk: "finance", reason: "no_payment_terms", by: "check" });
  assert.deepEqual(three!.holds.map((h) => h.check), ["no_payment_terms", "price_from_inventory"]);
  assert.equal(three!.text, HANDOFF_COPY);
  assert.ok(!results.some((r) => r.text?.includes("689")));
  assert.equal(lead.state, "handed_off");
});

test("the locked handoff copy passes every check, even after a night deferral", () => {
  const ctx = { facts: [], slots: [], decidedAt: new Date("2026-11-04T21:52:00-08:00"), sendAt: new Date("2026-11-05T08:00:00-08:00"), optedOut: false, store };
  assert.deepEqual(runChecks(HANDOFF_COPY, ctx), []);
});

test("a money question hands off before any model is asked", async () => {
  const model = spy({ next: "engaged", draft: "sure" });
  const { result } = await turn({ lead: fresh(), text: "What would my monthly payment be?", decidedAt: NOON, store, inventory, model });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(result.handoff, { desk: "finance", reason: "finance", by: "trigger" });
  assert.deepEqual(result.path, ["new", "engaged", "handed_off"]);
});

test("an illegal move proposed by the model becomes a handoff, not a send", async () => {
  const model = spy({ next: "booked", slot: "2026-11-05T17:30:00-08:00", draft: "You're booked for 5:30 pm." });
  const { result } = await turn({ lead: fresh(), text: "is it still there?", decidedAt: NOON, store, inventory, model });
  assert.equal(result.action, "handoff");
  assert.equal(result.handoff?.by, "illegal_move");
  assert.match(result.handoff?.reason ?? "", /engaged -> booked/);
});

test("a drive offer needs an available vehicle and slots inside drive hours after the send", async () => {
  const late = spy({ next: "drive_offered", slots: ["2026-11-05T20:30:00-08:00"], draft: "Thursday at 8:30 pm?" });
  const r1 = (await turn({ lead: fresh(), text: "can I see it?", decidedAt: NOON, store, inventory, model: late })).result;
  assert.match(r1.handoff?.reason ?? "", /outside drive hours/);
  const sold = spy({ next: "drive_offered", slots: ["2026-11-05T17:30:00-08:00"], draft: "Thursday at 5:30 pm?" });
  const r2 = (await turn({ lead: fresh({ stock: "U3990" }), text: "can I see it?", decidedAt: NOON, store, inventory, model: sold })).result;
  assert.match(r2.handoff?.reason ?? "", /not available/);
});

test("silence on a question is not allowed; silence on small talk is", async () => {
  const quiet = spy({ next: "engaged", draft: null });
  const asked = (await turn({ lead: fresh(), text: "is it still there?", decidedAt: NOON, store, inventory, model: quiet })).result;
  assert.equal(asked.action, "handoff");
  assert.equal(asked.handoff?.by, "unanswered_ask");
  const thanks = (await turn({ lead: fresh({ state: "booked" }), text: "thanks!", decidedAt: NOON, store, inventory, model: spy({ next: "booked", draft: null }) })).result;
  assert.equal(thanks.action, "no_reply");
});

test("a model error or malformed proposal hands off", async () => {
  const boom = (await turn({ lead: fresh(), text: "is it still there?", decidedAt: NOON, store, inventory, model: spy(new Error("timeout")) })).result;
  assert.equal(boom.handoff?.by, "model_error");
  const junk = (await turn({ lead: fresh(), text: "is it still there?", decidedAt: NOON, store, inventory, model: spy({ next: "sold" } as unknown as Proposal) })).result;
  assert.equal(junk.handoff?.by, "model_error");
});

test("STOP opts out with no reply, and a later message goes to a person", async () => {
  const model = spy({ next: "engaged", draft: "hi" });
  const stop = await turn({ lead: fresh({ state: "drive_offered" }), text: "STOP", decidedAt: NOON, store, inventory, model });
  assert.equal(stop.result.action, "opt_out");
  assert.equal(stop.result.text, null);
  const after = await turn({ lead: stop.lead, text: "actually is it still there?", decidedAt: NOON, store, inventory, model });
  assert.equal(after.result.action, "handoff");
  assert.equal(after.result.text, null);
  assert.equal(model.calls.length, 0);
});

test("every model request carries decidedAt and sendAt", async () => {
  const model = spy({ next: "engaged", draft: "Hi." });
  await turn({ lead: fresh(), text: "hello", decidedAt: "2026-11-04T21:52:00-08:00", store, inventory, model });
  assert.equal(model.calls[0]?.decidedAt, "2026-11-04T21:52:00-08:00");
  assert.equal(model.calls[0]?.sendAt, "2026-11-05T16:00:00.000Z");
  assert.throws(() => checkRequest({ ...model.calls[0]!, decidedAt: undefined as unknown as string }), /decidedAt/);
  assert.throws(() => checkRequest({ ...model.calls[0]!, decidedAt: "2026-11-04T21:52:00" }), /decidedAt/);
  await assert.rejects(turn({ lead: fresh(), text: "hi", decidedAt: "", store, inventory, model }), /decidedAt/);
});

test("lint: every model call in src goes through checkRequest", () => {
  for (const file of readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(ROOT, "src", file), "utf8");
    for (const m of src.matchAll(/\.propose\((\w+)\)/g)) {
      assert.match(src, new RegExp(`const ${m[1]} = checkRequest\\(`), `${file}: ${m[0]} without checkRequest`);
    }
  }
});
