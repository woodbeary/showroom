import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { backtestThread, gateExport, labelAt, loadBacktestDir, runFixtures, summarize, tagFor, type Thread } from "../src/backtest.ts";
import { routineModel } from "../src/standin.ts";
import { crossover, EX, inventory, store } from "./helpers.ts";

const T0 = "2026-10-01T18:00:00-07:00";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const thread = (events: Thread["events"], observedUntil = "2026-10-10T00:00:00Z"): Thread => ({ id: "t", leadId: "L", stock: crossover.stock, observedUntil, events });

test("labels come from what happened next", () => {
  const ask = { at: at(0), from: "customer" as const, text: "is it still there?" };
  assert.deepEqual(labelAt(thread([ask, { at: at(10), from: "template", template: "offer_times" }]), 0), { label: "reply" });
  assert.deepEqual(labelAt(thread([ask, { at: at(10), from: "staff", text: "calling you" }]), 0), { label: "handoff" });
  assert.deepEqual(labelAt(thread([ask, { at: at(10), from: "transfer", desk: "finance" }]), 0), { label: "handoff" });
  assert.deepEqual(labelAt(thread([ask, { at: at(1), from: "system", event: "opted_out" }]), 0), { label: "opt_out" });
  assert.deepEqual(labelAt(thread([ask, { at: at(30), from: "customer", text: "hello?" }]), 0), { label: "no_reply" });
  assert.deepEqual(labelAt(thread([ask]), 0), { label: "no_reply" });
  assert.deepEqual(labelAt(thread([ask], at(60)), 0), { unscored: "unknown" });
  assert.deepEqual(labelAt(thread([ask, { at: at(49 * 60), from: "template", template: "offer_times" }]), 0), { label: "no_reply" });
});

test("an agent-written next step is never a label", () => {
  const t = thread([{ at: at(0), from: "customer", text: "is it still there?" }, { at: at(5), from: "agent", text: "yes" }]);
  assert.deepEqual(labelAt(t, 0), { unscored: "agent_authored" });
});

test("failure modes are named from the label and the agent's action", () => {
  assert.equal(tagFor("handoff", "reply"), "missed_handoff");
  assert.equal(tagFor("reply", "no_reply"), "silent_on_ask");
  assert.equal(tagFor("no_reply", "handoff"), "extra_handoff");
  assert.equal(tagFor("no_reply", "reply"), "extra_message");
  assert.equal(tagFor("opt_out", "reply"), "missed_stop");
  assert.equal(tagFor("reply", "opt_out"), "false_stop");
  assert.equal(tagFor("reply", "reply"), null);
});

test("the example backtest: 200 threads, provenance kept, fixtures pass", async () => {
  const { threads, fixtures } = loadBacktestDir(join(EX, "transcripts"));
  const model = routineModel();
  const points = (await Promise.all(threads.map((t) => backtestThread(t, model, store, inventory)))).flat();
  const r = summarize(threads.length, points, await runFixtures(fixtures, model, store, crossover));
  assert.equal(r.threads, 200);
  assert.equal(r.points.length, 464);
  assert.equal(r.scored.length, 396);
  assert.equal(r.scored.filter((p) => !p.tag).length, 340);
  assert.ok(r.unscored.agent_authored > 0);
  assert.ok(r.fixtures.length >= 10 && r.fixtures.every((f) => f.passed), JSON.stringify(r.fixtures.filter((f) => !f.passed)));

  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const p of points) {
    const t = byId.get(p.threadId)!;
    const i = Number(p.id.split("#")[1]);
    const next = t.events.slice(i + 1).find((e) => e.from !== "customer");
    const nextCustomer = t.events.slice(i + 1).findIndex((e) => e.from === "customer");
    const nextIndex = next ? t.events.indexOf(next) : -1;
    if (next?.from === "agent" && (nextCustomer === -1 || nextIndex < i + 1 + nextCustomer)) {
      assert.equal(p.label, null, `${p.id} took a label from an agent-written step`);
    }
  }

  const { shadow, labels } = gateExport(points, "test", "2026-10-28T00:00:00Z");
  assert.equal(shadow.length, points.length);
  assert.equal(labels.length, r.scored.length);
  for (const l of labels as { decision: { decidedBy: string; action: string }; decidedAt: string; capturedAt: string }[]) {
    assert.equal(l.decision.decidedBy, "human");
    assert.ok(["approve", "skip"].includes(l.decision.action));
    assert.ok(l.capturedAt <= l.decidedAt);
  }
});
