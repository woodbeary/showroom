import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKS, runChecks, type CheckContext } from "../src/checks.ts";
import { crossover, store } from "./helpers.ts";

const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({
  facts: [crossover],
  slots: [new Date("2026-11-05T17:30:00-08:00"), new Date("2026-11-05T18:15:00-08:00")],
  decidedAt: new Date("2026-11-05T09:00:00-08:00"),
  sendAt: new Date("2026-11-05T09:00:00-08:00"),
  optedOut: false,
  store,
  ...over,
});

const names = (draft: string, c = ctx()) => runChecks(draft, c).map((h) => h.check);

test("a clean draft passes every check", () => {
  assert.deepEqual(names("It's listed at $31,900. I can have it up front Thursday at 5:30 pm or 6:15 pm."), []);
});

test("payment, APR, approval and credit language is held for the finance desk", () => {
  for (const d of ["about $689 a month", "with good credit you're set", "0.9% APR this week", "you're pre-approved", "we can get you financed", "payments around 700/mo"]) {
    const holds = runChecks(d, ctx());
    assert.ok(holds.some((h) => h.check === "no_payment_terms" && h.desk === "finance"), d);
  }
});

test("every price must equal a value the inventory returned", () => {
  assert.deepEqual(names("It's $31,900."), []);
  assert.deepEqual(names("It's 31.9k."), []);
  assert.deepEqual(names("I can do $30,500 for you."), ["price_from_inventory"]);
  assert.deepEqual(names("It's $31,900.", ctx({ facts: [] })), ["price_from_inventory"]);
  assert.deepEqual(names("Knock off 2 grand and it's yours."), ["price_from_inventory"]);
});

test("identity and banking asks are held", () => {
  for (const d of ["What's your date of birth?", "send me your SSN to get started", "what's your bank account number"]) {
    assert.ok(names(d).includes("no_sensitive_asks"), d);
  }
});

test("times and weekdays must be ones this turn offers", () => {
  assert.deepEqual(names("How about Friday at 5:30 pm?"), ["times_from_offer"]);
  assert.deepEqual(names("Thursday at 7 pm works?"), ["times_from_offer"]);
  assert.deepEqual(names("Thursday at 6:15pm then."), []);
});

test("'tomorrow' is held when the send goes out on a later day than the decision", () => {
  const night = ctx({ decidedAt: new Date("2026-11-04T21:52:00-08:00"), sendAt: new Date("2026-11-05T08:00:00-08:00") });
  assert.deepEqual(names("I can do tomorrow at 5:30 pm.", night), ["day_words_match_send_day"]);
  assert.deepEqual(names("I can do Thursday at 5:30 pm.", night), []);
  assert.deepEqual(names("I can do tomorrow at 5:30 pm.", ctx()), []);
});

test("tone: length, shouting, exclamation marks and pressure phrases", () => {
  assert.deepEqual(names("Come in TODAY!"), ["tone"]);
  assert.deepEqual(names("Great!! See you"), ["tone"]);
  assert.deepEqual(names("Hurry, it won't last."), ["tone"]);
  assert.deepEqual(names("x".repeat(321)), ["tone"]);
});

test("an opted-out lead gets nothing, whatever the draft says", () => {
  assert.deepEqual(names("Thanks!", ctx({ optedOut: true })), ["stop_honored"]);
});

test("checks report every failure in pipeline order and never return text to send", () => {
  const draft = "It's listed at $31,900. With good credit that's about $689 a month.";
  const holds = runChecks(draft, ctx());
  assert.deepEqual(holds.map((h) => h.check), ["no_payment_terms", "price_from_inventory"]);
  for (const c of CHECKS) {
    const out = c.run(draft, ctx());
    assert.ok(out === null || (typeof out === "string" && out !== draft), c.name);
  }
});
