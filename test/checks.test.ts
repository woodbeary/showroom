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
  assert.deepEqual(names("Knock off 2 grand and it's yours."), ["price_from_inventory", "no_deal_terms"]);
});

test("a price without a dollar sign, or in words, must still be one inventory returned", () => {
  for (const d of ["We can do 29,900 on it.", "It's yours for 29900", "Price drops to thirty thousand flat", "I can take two grand off."]) {
    const holds = runChecks(d, ctx());
    assert.ok(holds.some((h) => h.check === "price_from_inventory" && h.desk === "sales_manager"), d);
  }
  assert.deepEqual(names("It's listed at 31,900."), []);
  assert.deepEqual(names("It's a 2023 with 21,400 miles."), []);
  assert.deepEqual(names("It's got about thirty thousand miles."), []);
});

test("dealer shorthand and spelled-out figures must still be ones inventory returned", () => {
  for (const d of ["We can do 29.9 on it.", "twenty-nine nine and it's yours", "I'll let it go for 30.", "I can do a thousand less", "thirty-one nine", "29-30k is the range", "29 900 flat"]) {
    const holds = runChecks(d, ctx());
    assert.ok(holds.some((h) => h.check === "price_from_inventory" && h.desk === "sales_manager"), d);
  }
  assert.deepEqual(names("It's 31.9."), []);
  assert.deepEqual(names("It's listed at 31,900, or 31.9k if you like."), []);
});

test("a number is a year only when inventory returned that model year, and a letter after it is not a unit", () => {
  for (const d of ["We can do it for 2000 less.", "Add 1995 and it's yours.", "We can do 30ish on it.", "It's yours for 29900usd", "I can do 30g on it.", "two nine nine and it's yours"]) {
    assert.deepEqual(names(d), ["price_from_inventory"], d);
  }
  assert.deepEqual(names("It's a 2023."), []);
  assert.deepEqual(names("It's a 2023.", ctx({ facts: [] })), ["price_from_inventory"]);
  assert.deepEqual(names("It's the 2nd of two we have, with an 800V system."), []);
});

test("numbers that are not money pass: times, years, counts and measured units", () => {
  for (const d of [
    "It's here and ready to drive. I can have it up front Thursday at 5:30 pm or 6:15 pm. Which works better?",
    "It's a 2023 with 21,400 miles, seats 5, and charges at 11.5 kW.",
    "Range is about 300 miles on a full charge, and it has two keys and one owner.",
    "Thursday 11/5 at 5:30 pm works. Twenty minutes is plenty for the drive.",
    "Feel free to stop by Thursday at 5:30 pm. It's one of two we have, and the other is on hold for another buyer.",
  ]) {
    assert.deepEqual(names(d), [], d);
  }
});

test("promises, concessions and price talk the model starts are held for the sales manager", () => {
  for (const d of ["I promise it's yours at $31,900.", "We'll throw in free charging.", "We'll waive the doc fee.", "$31,900 is my final price.", "I'll get you a better number.", "We can meet you in the middle.", "I can hold it for you until Thursday.", "Let me see what I can do on price.",
    "I'll put it on hold for you.", "I can reserve the crossover for you.", "I'll throw a charger in.", "Let's split the difference.", "We can meet you halfway.",
    "I'll work with you on the price.", "No doc fee for you.", "We'll include a home charger at no cost.", "We'll pay your registration."]) {
    const holds = runChecks(d, ctx());
    assert.ok(holds.some((h) => h.check === "no_deal_terms" && h.desk === "sales_manager"), d);
  }
});

test("discounts, out-the-door figures and guarantees are held for the sales manager", () => {
  for (const d of ["Price is $31,900 out the door.", "Guaranteed you'll get it today.", "I can knock 500 off", "We can do $500 off sticker.", "That's a great deal at $31,900."]) {
    const holds = runChecks(d, ctx());
    assert.ok(holds.some((h) => h.check === "no_deal_terms" && h.desk === "sales_manager"), d);
  }
  assert.deepEqual(names("The dealership team will have it charged. Ask for the front desk."), []);
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
