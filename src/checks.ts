import { clockText, localTime, sameLocalDay } from "./clock.ts";
import type { Desk } from "./intent.ts";
import type { Store, Vehicle } from "./store.ts";

export interface CheckContext {
  facts: readonly Vehicle[];
  slots: readonly Date[];
  decidedAt: Date;
  sendAt: Date;
  optedOut: boolean;
  store: Store;
}

export interface Hold {
  check: string;
  detail: string;
}

export interface Check {
  name: string;
  desk: Desk;
  run(draft: string, ctx: CheckContext): string | null;
}

const SENSITIVE =
  /\b(?:ssn|social security|date of birth|dob|birth ?date|birthday|driver['’]?s? licen[sc]e (?:number|#|no)|license number|bank account|routing number|account number|card number)\b/i;

const PAYMENT_TERMS =
  /(?:\b(?:a|per)\s+mo(?:nth)?\b|\/\s*mo(?:nth)?\b|\bmonthly\b|\bpayments?\b|\bapr\b|\binterest\b|\brates?\b|\bapprov\w*|\bpre-?qual\w*|\bcredit\b|\bfinanc\w*|\bdown payment\b|\blease\b|\bleasing\b|\d\s*%)/gi;

const MONEY = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?|\b(\d[\d,]*(?:\.\d+)?)\s*(k|grand|dollars|bucks)\b/gi;

const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bnoon\b/gi;

const WEEKDAY = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;

const DAY_WORDS = /\b(today|tonight|tomorrow|this (?:morning|afternoon|evening))\b/i;

function amounts(draft: string): { text: string; value: number }[] {
  const out: { text: string; value: number }[] = [];
  for (const m of draft.matchAll(MONEY)) {
    const digits = (m[1] ?? m[3] ?? "").replace(/,/g, "");
    const unit = (m[2] ?? m[4] ?? "").toLowerCase();
    const scale = unit === "k" || unit === "grand" ? 1000 : 1;
    out.push({ text: m[0].trim(), value: Math.round(Number(digits) * scale) });
  }
  return out;
}

export const CHECKS: readonly Check[] = [
  {
    name: "stop_honored",
    desk: "salesperson",
    run: (_draft, ctx) => (ctx.optedOut ? "the customer opted out; nothing may be sent" : null),
  },
  {
    name: "no_sensitive_asks",
    desk: "finance",
    run: (draft) => {
      const m = SENSITIVE.exec(draft);
      return m ? `asks for "${m[0]}"; identity and banking details go through the finance desk` : null;
    },
  },
  {
    name: "no_payment_terms",
    desk: "finance",
    run: (draft) => {
      const found = [...new Set([...draft.matchAll(PAYMENT_TERMS)].map((m) => `"${m[0].trim()}"`))];
      return found.length ? `${found.join(", ")}: payments, rates, credit and approval belong to the finance desk` : null;
    },
  },
  {
    name: "price_from_inventory",
    desk: "sales_manager",
    run: (draft, ctx) => {
      const known = new Set(ctx.facts.map((v) => v.price));
      const bad = amounts(draft).filter((a) => !known.has(a.value));
      if (bad.length === 0) return null;
      const listed = ctx.facts.map((v) => `${v.stock} $${v.price.toLocaleString("en-US")}`).join(", ") || "nothing";
      return `${bad.map((a) => a.text).join(", ")} not a price the inventory returned (it returned ${listed})`;
    },
  },
  {
    name: "times_from_offer",
    desk: "salesperson",
    run: (draft, ctx) => {
      const local = ctx.slots.map((s) => localTime(s, ctx.store.timeZone));
      const offered = new Set(local.map((t) => clockText(t)));
      const days = new Set(local.map((t) => t.weekday));
      const bad: string[] = [];
      for (const m of draft.matchAll(CLOCK)) {
        if (m[0].toLowerCase() === "noon") {
          if (!offered.has("12:00 pm")) bad.push(m[0]);
          continue;
        }
        const hour = (Number(m[1]) % 12) + ((m[3] ?? "").toLowerCase() === "pm" ? 12 : 0);
        const text = clockText({ year: 0, month: 1, day: 1, hour, minute: Number(m[2] ?? 0), weekday: "" });
        if (!offered.has(text)) bad.push(m[0]);
      }
      for (const m of draft.matchAll(WEEKDAY)) {
        if (!days.has((m[1] ?? "").toLowerCase())) bad.push(m[0]);
      }
      return bad.length ? `${bad.join(", ")} not among the times this turn offers or books` : null;
    },
  },
  {
    name: "day_words_match_send_day",
    desk: "salesperson",
    run: (draft, ctx) => {
      const m = DAY_WORDS.exec(draft);
      if (!m || sameLocalDay(ctx.decidedAt, ctx.sendAt, ctx.store.timeZone)) return null;
      return `"${m[0]}" was decided on one day and goes out on the next`;
    },
  },
  {
    name: "tone",
    desk: "salesperson",
    run: (draft, ctx) => {
      const t = ctx.store.tone;
      const problems: string[] = [];
      if (draft.length > t.maxChars) problems.push(`${draft.length} characters > ${t.maxChars}`);
      const bangs = (draft.match(/!/g) ?? []).length;
      if (bangs > t.maxExclamations) problems.push(`${bangs} exclamation marks > ${t.maxExclamations}`);
      const shout = draft.match(/\b[A-Z]{4,}\b/);
      if (shout) problems.push(`shouting "${shout[0]}"`);
      const lower = draft.toLowerCase();
      for (const p of t.pressurePhrases) if (lower.includes(p.toLowerCase())) problems.push(`pressure "${p}"`);
      return problems.length ? problems.join("; ") : null;
    },
  },
];

export function runChecks(draft: string, ctx: CheckContext, checks: readonly Check[] = CHECKS): (Hold & { desk: Desk })[] {
  const holds: (Hold & { desk: Desk })[] = [];
  for (const c of checks) {
    const detail = c.run(draft, ctx);
    if (detail !== null) holds.push({ check: c.name, detail, desk: c.desk });
  }
  return holds;
}
