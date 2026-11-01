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

const NUMBER = /(?<![\w.,:/$])(\$\s?)?(\d[\d,]*)(\.\d+)?/g;

const MONEY_UNIT = /^\s*(k|grand|dollars?|bucks)\b/i;

const NOT_MONEY_AFTER =
  /^(?:\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|:\d|\/\d|(?:st|nd|rd|th)\b|[\s-]*(?:%|°|(?:miles?|mi|mph|mpg|mpge|kw|kwh|kilowatt\w*|minutes?|mins?|hours?|hrs?|days?|weeks?|seconds?|secs?|seats?|seaters?|doors?|rows?|inch(?:es)?|ft|feet|foot|lbs?|pounds|v|volts?|amps?|hp|horsepower|cubic|percent|degrees?|owners?|keys?|cylinders?|passengers?|people|stars?)\b))/i;

const YEAR = /\b(?:19|20)\d{2}\b/g;

const COUNT_BELOW = 13;

const NUMBER_WORD =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand|few|couple";

const SPELLED = new RegExp(`\\b(?:an?\\s+)?(?:${NUMBER_WORD})(?:(?:[\\s-]+(?:and|of))?[\\s-]+(?:${NUMBER_WORD}))*\\b`, "gi");

const SPELLED_LARGE = /\b(?:thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|grand)\b/i;

const SPELLED_RUN = new RegExp(`\\b(?:${NUMBER_WORD})[\\s-]+(?:${NUMBER_WORD})\\b`, "i");

const DEAL_TERMS =
  /\b(?:discount\w*|rebates?|incentives?|negotiab\w*|deals?|out[\s-]the[\s-]door|otd|guarantee\w*|promis\w*|best price|lowest price|final (?:price|offer|number)|better (?:number|price|deal|offer)|price (?:drop|cut|match)\w*|(?:below|under) (?:list|sticker|asking|msrp)|knock\w*|shave\w*|wiggle room|thr(?:ow(?:ing|n|s)?|ew)\s+(?:[\w'’]+\s+){0,3}?in|waiv\w*|meet you (?:at|in the middle)|meet (?:you )?half[\s-]?way|split the difference|(?:hold|holding|reserve|reserving|save|saving|set aside|setting aside)\s+(?:it|this|that|one|(?:the|this|that|your)\s+\w+)\s+(?:for\s+(?:you|u|ya)|until|till|til|through|thru)|(?:put|putting)\s+(?:it|this|that|(?:the|this|that|your)\s+\w+)\s+on\s+hold|on\s+hold\s+for\s+(?:you|u|ya)|(?:do|work)\s+(?:something\s+|with\s+you\s+)?on\s+(?:the\s+)?price|(?:no|zero)\s+(?:doc(?:ument)?\s+|dealer\s+|admin\s+|processing\s+)?fees?|at no (?:extra |additional )?(?:cost|charge)|free of charge|on the house|complimentary|free\s+(?:home\s+)?(?:charging|charger|floor\s+mats|mats|maintenance|service|tint|warranty|accessor\w+|delivery|shipping|upgrades?)|(?:cover|pay|pick\s+up)\s+(?:the|your)\s+(?:registration|taxes|tax|title|fees?|doc\s+fee|shipping|delivery))\b|(?:\d|\b(?:grand|hundred|thousand|bucks|dollars))\s*k?\s+off\b/gi;

const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bnoon\b/gi;

const WEEKDAY = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;

const DAY_WORDS = /\b(today|tonight|tomorrow|this (?:morning|afternoon|evening))\b/i;

interface Amount {
  text: string;
  values: number[];
}

function modelYears(facts: readonly Vehicle[]): Set<string> {
  return new Set(facts.flatMap((v) => v.title.match(YEAR) ?? []));
}

function amounts(draft: string, years: ReadonlySet<string>): Amount[] {
  const out: Amount[] = [];
  for (const m of draft.matchAll(NUMBER)) {
    const digits = (m[2] ?? "").replace(/,+$/, "");
    const decimal = m[3] ?? "";
    const rest = draft.slice((m.index ?? 0) + m[0].length);
    const unit = MONEY_UNIT.exec(rest);
    const dollar = Boolean(m[1]);
    const face = Number(`${digits.replace(/,/g, "")}${decimal}`);
    if (unit) {
      const scale = /^(?:k|grand)$/i.test(unit[1] ?? "") ? 1000 : 1;
      out.push({ text: `${m[0]}${unit[0]}`.trim(), values: [Math.round(face * scale)] });
      continue;
    }
    if (dollar) {
      out.push({ text: m[0].trim(), values: [Math.round(face)] });
      continue;
    }
    if (NOT_MONEY_AFTER.test(rest)) continue;
    if (!decimal && (years.has(digits) || face < COUNT_BELOW)) continue;
    out.push({ text: m[0], values: face < 1000 ? [face, Math.round(face * 1000)] : [Math.round(face)] });
  }
  for (const m of draft.matchAll(SPELLED)) {
    const rest = draft.slice((m.index ?? 0) + m[0].length);
    if ((SPELLED_LARGE.test(m[0]) || SPELLED_RUN.test(m[0])) && !NOT_MONEY_AFTER.test(rest)) out.push({ text: m[0], values: [] });
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
      const bad = amounts(draft, modelYears(ctx.facts)).filter((a) => !a.values.some((v) => known.has(v)));
      if (bad.length === 0) return null;
      const listed = ctx.facts.map((v) => `${v.stock} $${v.price.toLocaleString("en-US")}`).join(", ") || "nothing";
      return `${bad.map((a) => a.text).join(", ")} not a price the inventory returned (it returned ${listed})`;
    },
  },
  {
    name: "no_deal_terms",
    desk: "sales_manager",
    run: (draft) => {
      const found = [...new Set([...draft.matchAll(DEAL_TERMS)].map((m) => `"${m[0].trim()}"`))];
      return found.length ? `${found.join(", ")}: discounts, out-the-door figures and guarantees belong to the sales manager` : null;
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
