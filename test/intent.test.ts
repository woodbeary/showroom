import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ASKS, CONTACT_REQUEST, NOT_YET, readInbound, RULES, TRIGGERS, type Kind, type Rules } from "../src/intent.ts";
import { EX } from "./helpers.ts";

interface Fixture {
  id: string;
  text: string;
  expect: { kind?: Kind; notKind?: Kind; asks?: boolean };
}

const fixtures = readFileSync(join(EX, "transcripts", "regressions.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Fixture);

function meets(f: Fixture, rules: Rules): boolean {
  const r = readInbound(f.text, rules);
  const x = f.expect;
  return (x.kind === undefined || x.kind === r.kind) && (x.notKind === undefined || x.notKind !== r.kind) && (x.asks === undefined || x.asks === r.asks);
}

test("every regression fixture's reading holds under today's rules", () => {
  for (const f of fixtures) assert.ok(meets(f, RULES), `${f.id}: ${JSON.stringify(readInbound(f.text))}`);
});

test("the 'have your number' fixture catches the rule it was written for", () => {
  const before: Rules = {
    ...RULES,
    triggers: TRIGGERS.filter((t) => t !== CONTACT_REQUEST),
    notYet: NOT_YET.map((p, i) => (i === 1 ? /\b(?:keep|kept|save|saved|saving|have)\s+(?:your|ur)\s+(?:info|information|number|contact|card|details)\b/i : p)),
  };
  const f = fixtures.find((x) => x.id === "have-your-number")!;
  assert.equal(readInbound(f.text, before).kind, "not_yet");
  assert.equal(meets(f, before), false);
  assert.equal(meets(f, RULES), true);
});

test("an ask beats a decline word in the same message", () => {
  const r = readInbound("What's a good number for you? I might have bought something else by then");
  assert.equal(r.kind, "handoff");
  assert.equal(r.trigger, "contact_request");
  assert.equal(r.asks, true);
});

test("a referral is not a decline, and a conditional need is not an ask", () => {
  assert.equal(readInbound("I'll pass it along to my brother").kind, "not_yet");
  assert.equal(readInbound("we'll pass, thanks").kind, "decline");
  assert.equal(readInbound("let me see if we need a second car").asks, false);
  assert.equal(readInbound("we need a second car").asks, true);
});

test("money, trade, negotiation, complaints and people go to the right desk", () => {
  const cases: [string, string][] = [
    ["What would my monthly payment be?", "finance"],
    ["can I get approved with 640 credit?", "finance"],
    ["trying to stay under 700/mo", "finance"],
    ["Do you take trade-ins?", "appraisal"],
    ["what's your best price on it?", "sales_manager"],
    ["can you do 29k?", "sales_manager"],
    ["you guys never called me back", "customer_relations"],
    ["can I talk to a real person", "salesperson"],
  ];
  for (const [text, desk] of cases) assert.equal(readInbound(text).desk, desk, text);
});

test("STOP is honored as a whole-message keyword, not inside other requests", () => {
  for (const t of ["STOP", "stop.", "Unsubscribe", "stop texting me", "please don't text me anymore"]) assert.equal(readInbound(t).kind, "stop", t);
  for (const t of ["Cancel my Thursday drive", "don't stop, this is great", "can it stop at a charger on the way?"]) assert.notEqual(readInbound(t).kind, "stop", t);
});

test("timing words alone are not payment talk", () => {
  assert.equal(readInbound("I'll be ready in a month or so").desk, null);
  assert.equal(readInbound("$650 a month is my max").desk, "finance");
});

test("ask patterns are case-insensitive and stateless", () => {
  for (const p of [...ASKS, ...NOT_YET]) {
    assert.ok(p.flags.includes("i"), String(p));
    assert.equal(p.flags.includes("g"), false, String(p));
  }
});
