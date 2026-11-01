import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Thread, ThreadEvent } from "../src/backtest.ts";
import { clockText, earliestSend, localTime } from "../src/clock.ts";
import { assignArm } from "../src/holdout.ts";
import { nextSlots } from "../src/standin.ts";
import { loadInventory, loadStore, type Vehicle } from "../src/store.ts";

const ROOT = resolve(import.meta.dirname, "..");
const EX = join(ROOT, "examples");
const store = loadStore(join(EX, "store.json"));
const inventory = loadInventory(join(EX, "inventory.json"));

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20261101);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function weighted<T extends string>(w: Record<T, number>): T {
  const entries = Object.entries(w) as [T, number][];
  let r = rand() * entries.reduce((s, [, n]) => s + n, 0);
  for (const [k, n] of entries) if ((r -= n) < 0) return k;
  return entries[entries.length - 1]![0];
}

const SAY = {
  availability: [
    "Is the {v} still available?",
    "hi is this still for sale?",
    "Can I come see it {day}?",
    "is it still there? can I test drive it after work?",
    "Do you have it on the lot right now?",
    "When could I see it?",
    "what time do you close? could I swing by and look at it?",
  ],
  hardAsk: [
    "still around? my sister wants to see it",
    "my husband and I are free saturday morning if that works",
    "would love to take it for a spin this weekend",
  ],
  finance: [
    "What would my monthly payment be?",
    "can I get approved with 640 credit?",
    "do you guys do financing?",
    "is there a lease option on this one?",
  ],
  hardFinance: [
    "what kind of numbers are we talking if I put 5k down",
    "my wife wants to know what we'd be paying every month",
    "I've got about a 650 score, is that going to be an issue",
  ],
  trade: ["Do you take trade-ins?", "what's my truck worth if I bring it in?", "I want to trade in my 2018 sedan, how does that work?"],
  hardTrade: ["I've got a 2019 sedan I'd want to get rid of as part of this", "could you guys take my old truck off my hands too?"],
  negotiation: ["what's your best price on it?", "can you do 29k?", "any wiggle room on the price?", "what's the out the door number?"],
  contact: ["Can I have your number?", "please call me, I'm at work", "what's a good number to reach you?"],
  hardContact: ["best way to reach you? texting is hard at work"],
  complaint: ["you guys never called me back last time", "your salesperson was rude to my mom last week"],
  stop: ["STOP", "stop texting me", "Unsubscribe"],
  decline: ["already bought one elsewhere, thanks", "we'll pass, thanks", "not interested anymore"],
  notYet: ["just looking for now", "I'll keep you in mind", "maybe next month", "not quite ready yet, saving your number"],
  smallTalk: ["thanks!", "ok cool", "sounds good", "\u{1F44D}"],
  seeYou: ["see you then!", "perfect, see you then", "great thanks"],
  reschedule: ["can we push back my appointment? running late", "can I reschedule my test drive? something came up"],
  falseHandoff: [
    "the loan officer at my credit union already sorted it, see you then",
    "haha my brother says call me crazy for going electric. see you then",
  ],
  afterHandoff: ["ok thanks", "sounds good, talk soon"],
};

const DESK = { finance: "finance", trade: "appraisal", negotiation: "sales_manager", complaint: "customer_relations" } as const;

type First = "availability" | "hardAsk" | "finance" | "hardFinance" | "trade" | "hardTrade" | "negotiation" | "contact" | "hardContact" | "complaint" | "stop" | "decline" | "notYet";

const FIRST: Record<First, number> = {
  availability: 46,
  hardAsk: 6,
  finance: 7,
  hardFinance: 4,
  trade: 5,
  hardTrade: 3,
  negotiation: 6,
  contact: 5,
  hardContact: 2,
  complaint: 2,
  stop: 3,
  decline: 4,
  notYet: 7,
};

const OBSERVED_UNTIL = Date.parse("2026-10-28T07:00:00Z");

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function staffTime(after: number): number {
  return earliestSend(new Date(after + between(3, 50) * MIN), store.quietHours, store.timeZone).getTime() + Math.floor(between(0, 25)) * MIN;
}

function thread(n: number): Thread {
  const id = `t-${String(n).padStart(4, "0")}`;
  const wantAvailable = rand() < 0.85;
  const vehicle: Vehicle = pick(inventory.filter((v) => (v.status === "available") === wantAvailable));
  const startDay = Date.parse("2026-09-14T07:00:00Z") + Math.floor(between(0, 42)) * DAY;
  let t = startDay + between(14, 30.5) * HOUR;
  const events: ThreadEvent[] = [];
  const agentEra = t > Date.parse("2026-10-19T07:00:00Z") && rand() < 0.15;
  type Phase = "open" | "offered" | "booked" | "owned" | "ended";
  let state = "open" as Phase;
  let offered: string[] = [];

  const customer = (text: string) => events.push({ at: iso(t), from: "customer", text });
  const say = (bank: readonly string[]) => customer(pick(bank).replace("{v}", vehicle.title.replace(/^\d{4} /, "")).replace("{day}", pick(["saturday", "tomorrow", "after work"])));
  const reply = (e: Omit<ThreadEvent, "at" | "from">, at = staffTime(t)) => {
    t = at;
    events.push({ at: iso(t), from: agentEra ? "agent" : "template", ...e });
  };
  const offerTimes = () => {
    if (vehicle.status !== "available") {
      t = staffTime(t);
      events.push({ at: iso(t), from: "staff", text: "That one is spoken for, but I have two close to it. Want me to send them over?" });
      state = "owned";
      return;
    }
    const sendAt = staffTime(t);
    offered = nextSlots({ sendAt: iso(sendAt), store });
    const [a, b] = offered.map((s) => localTime(new Date(s), store.timeZone));
    reply({ template: "offer_times", slots: offered, text: `It's here. I can do ${a?.weekday} at ${a ? clockText(a) : ""} or ${b ? clockText(b) : ""}.` }, sendAt);
    state = "offered";
  };
  const transfer = (desk: (typeof DESK)[keyof typeof DESK]) => {
    t = staffTime(t);
    events.push({ at: iso(t), from: "transfer", desk });
    t += between(5, 40) * MIN;
    events.push({ at: iso(t), from: "staff", text: "Hi, this is the desk you were passed to. Happy to help with that." });
    state = "owned";
  };
  const respond = (kind: string) => {
    if (kind === "availability" || kind === "hardAsk" || kind === "reschedule") return offerTimes();
    if (kind === "finance" || kind === "hardFinance") return transfer(DESK.finance);
    if (kind === "trade" || kind === "hardTrade") return transfer(DESK.trade);
    if (kind === "negotiation") return transfer(DESK.negotiation);
    if (kind === "complaint") return transfer(DESK.complaint);
    if (kind === "contact" || kind === "hardContact") {
      t = staffTime(t);
      events.push({ at: iso(t), from: "staff", text: "Sure, calling you in a few minutes." });
      state = "owned";
      return;
    }
    if (kind === "stop") {
      events.push({ at: iso(t + MIN), from: "system", event: "opted_out" });
      state = "ended";
      return;
    }
    if (kind === "decline") {
      reply({ template: "close", text: "Thanks for letting us know. Text this number anytime." });
      state = "ended";
      return;
    }
    if (kind === "notYet") return reply({ template: "keep_in_touch", text: "No rush. Text this number whenever you're ready." });
  };

  const first = weighted(FIRST);
  say(SAY[first]);
  respond(first);

  for (let turnNo = 0; turnNo < 3 && state !== "ended"; turnNo++) {
    t += between(10, 360) * MIN;
    if (state === "owned") {
      if (rand() < 0.5) customer(pick(SAY.afterHandoff));
      break;
    }
    if (state === "offered") {
      const k = weighted({ accept: 70, smallTalk: 10, finance: 10, hardAsk: 5, stop: 5 });
      if (k === "accept") {
        const slot = pick(offered);
        const at = localTime(new Date(slot), store.timeZone);
        customer(`${clockText(at).replace(/ (am|pm)$/, "")} ${pick(["works", "is perfect", "works for me"])}`);
        reply({ template: "confirm_booking", slot, text: "You're booked. See you then." });
        state = "booked";
      } else if (k === "smallTalk") customer(pick(SAY.smallTalk));
      else {
        say(SAY[k]);
        respond(k);
      }
      continue;
    }
    if (state === "booked") {
      const k = weighted({ seeYou: 40, reschedule: 15, finance: 15, falseHandoff: 10, end: 20 });
      if (k === "end") break;
      say(SAY[k]);
      if (k === "reschedule" || k === "finance") respond(k);
      continue;
    }
    const k = weighted({ end: 50, availability: 35, smallTalk: 15 });
    if (k === "end") break;
    if (k === "availability") t += between(2, 9) * DAY;
    say(SAY[k]);
    respond(k);
  }
  return { id, leadId: `L-${String(n).padStart(4, "0")}`, stock: vehicle.stock, observedUntil: iso(OBSERVED_UNTIL), events: events.filter((e) => Date.parse(e.at) <= OBSERVED_UNTIL) };
}

function experiment(dir: string): void {
  const prereg = JSON.parse(readFileSync(join(dir, "preregistration.json"), "utf8"));
  const { salt, holdoutShare } = prereg.assignment;
  const launch = Date.parse(prereg.launchAt);
  const enrollUntil = Date.parse(prereg.enrollUntil);
  const leads: string[] = ["lead_id,created_at,arm"];
  const sales: string[] = ["deal_id,lead_id,sold_at,system"];
  const bookings: string[] = [];
  let deal = 0;
  const sale = (leadId: string, at: number) => sales.push(`D-${String(++deal).padStart(5, "0")},${leadId},${iso(at)},dealer_sales_record`);
  for (let i = 1; i <= 40; i++) {
    const created = launch - between(1, 10) * DAY;
    leads.push(`P-${String(i).padStart(4, "0")},${iso(created)},`);
    if (rand() < 0.06) sale(`P-${String(i).padStart(4, "0")}`, created + between(1, 25) * DAY);
  }
  for (let i = 1; i <= 2000; i++) {
    const id = `X-${String(i).padStart(5, "0")}`;
    const created = launch + rand() * (enrollUntil - launch);
    const arm = assignArm(id, salt, holdoutShare);
    leads.push(`${id},${iso(created)},${arm}`);
    if (rand() < 0.06) sale(id, created + between(0.5, 30) * DAY);
    else if (rand() < 0.01) sale(id, created + between(31, 45) * DAY);
    if (arm === "agent" && rand() < 0.35) {
      bookings.push(JSON.stringify({ writtenBy: "showroom", leadId: id, state: "booked", bookedAt: iso(created + between(0.1, 3) * DAY) }));
    }
  }
  for (let i = 0; i < 12; i++) sales.push(`D-${String(++deal).padStart(5, "0")},,${iso(launch + rand() * (enrollUntil - launch))},dealer_sales_record`);
  writeFileSync(join(dir, "leads.csv"), `${leads.join("\n")}\n`);
  writeFileSync(join(dir, "sales.csv"), `${sales.join("\n")}\n`);
  writeFileSync(join(dir, "agent-bookings.jsonl"), `${bookings.join("\n")}\n`);
  const sha256 = createHash("sha256").update(readFileSync(join(dir, "preregistration.json"))).digest("hex");
  writeFileSync(join(dir, "launch.json"), `${JSON.stringify({ launchedAt: prereg.launchAt, preregistration: { path: "preregistration.json", sha256 } }, null, 2)}\n`);
}

const threads = Array.from({ length: 200 }, (_, i) => thread(i + 1));
mkdirSync(join(EX, "transcripts"), { recursive: true });
writeFileSync(join(EX, "transcripts", "threads.jsonl"), `${threads.map((x) => JSON.stringify(x)).join("\n")}\n`);
experiment(join(EX, "experiment"));
console.log(`wrote ${threads.length} threads and the synthetic experiment`);
