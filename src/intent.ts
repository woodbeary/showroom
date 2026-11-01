export type Desk = "finance" | "appraisal" | "sales_manager" | "customer_relations" | "salesperson";

export const DESK_NAMES: Readonly<Record<Desk, string>> = {
  finance: "finance desk",
  appraisal: "trade appraisal",
  sales_manager: "sales manager",
  customer_relations: "customer relations",
  salesperson: "salesperson",
};

export type Kind = "stop" | "possible_stop" | "handoff" | "ask" | "decline" | "not_yet" | "other";

export interface Reading {
  kind: Kind;
  asks: boolean;
  trigger: string | null;
  desk: Desk | null;
}

export interface Trigger {
  name: string;
  desk: Desk;
  asks: boolean;
  patterns: readonly RegExp[];
}

export interface Rules {
  stop: readonly RegExp[];
  possibleStop: readonly RegExp[];
  triggers: readonly Trigger[];
  asks: readonly RegExp[];
  declines: readonly RegExp[];
  notYet: readonly RegExp[];
}

export const STOP: readonly RegExp[] = [
  /^\s*(?:stop\s*all|end|quit|cancel)\s*[.!]*\s*$/i,
  /^\s*(?:please\s+)?(?:stop|unsubscribe|revoke|opt[\s-]?out)(?:\s+(?:please|pls|plz|now|thanks|thank you|thx))?\s*[.!]*\s*$/i,
  /\b(?:do not|don['’]?t|dont|stop)\s+(?:text|texting|message|messaging|contact|contacting)\s+me\b/i,
  /\b(?:leave me alone|remove me from|take me off)\b/i,
  /\b(?:unsubscribe\s+me|opt\s+me\s+out)\b/i,
  /(?<!\b(?:don['’]?t|do not|dont|not|never)\s+)\b(?:want|wanna|would like|wish)\s+to\s+(?:opt[\s-]?out|unsubscribe)\b/i,
  /\brevoke\s+(?:my\s+|all\s+)?consent\b/i,
];

export const POSSIBLE_STOP: readonly RegExp[] = [
  /\b(?:unsubscribe|revoke|opt(?:ing)?[\s-]?out)\b/i,
  /\bstop\s+(?:sending|texting|messaging|contacting)\b/i,
  /\bno\s+more\s+(?:texts?|txts?|messages?|msgs?)\b/i,
  /\bwrong\s+(?:number|person|#)/i,
  /\bstop\s+(?:the|these|those|your|all\s+the)\s+(?:texts?|txts?|messages?|msgs?)\b/i,
  /\bremove\s+me\b/i,
  /(?<!\b(?:don['’]?t|do not|dont|never)\s+)\b(?:lose|delete|forget)\s+(?:my|this)\s+(?:number|#|contact|info)\b/i,
  /^\s*stop\s+it\b/i,
  /^\s*stop\s*[.!,]/i,
  /\bstop\s*[.!]*\s*$/i,
];

export const CONTACT_REQUEST: Trigger = {
  name: "contact_request",
  desk: "salesperson",
  asks: true,
  patterns: [
    /\b(?:can|could|may)\s+i\s+(?:have|get)\s+(?:your|ur|a)\s+(?:number|phone|cell|contact|email|info)\b/i,
    /\b(?:what(?:['’]s|\s+is)|whats)\s+(?:a|your|ur|the|a good)\s+(?:good\s+)?(?:number|phone|cell|email|contact)\b/i,
    /\b(?:call|ring)\s+me\b/i,
    /\bgive\s+me\s+a\s+call\b/i,
  ],
};

export const TRIGGERS: readonly Trigger[] = [
  {
    name: "complaint",
    desk: "customer_relations",
    asks: false,
    patterns: [
      /\b(?:complaint|complain|rude|unprofessional|scam|ripped off|lied to|lawyer|attorney|refund|furious|worst)\b/i,
      /\bnever\s+(?:called|showed|got back|heard back)\b/i,
    ],
  },
  {
    name: "finance",
    desk: "finance",
    asks: true,
    patterns: [
      /\b(?:payments?|monthly|per month|apr|interest rate|financ\w*|loan|credit|approv\w*|pre-?qual\w*|down payment|lease|leasing|co-?sign\w*)\b/i,
      /\$?\d[\d,]*\s*(?:\/\s*mo(?:nth)?|a\s+month|per\s+month|monthly)\b/i,
    ],
  },
  {
    name: "trade_in",
    desk: "appraisal",
    asks: true,
    patterns: [
      /\b(?:trade[- ]?ins?|trading\s+(?:in|my)|my trade|apprais\w*|payoff)\b/i,
      /\bwhat(?:['’]s|\s+is|\s+would)\s+my\s+(?:car|truck|suv|van)\b/i,
    ],
  },
  {
    name: "price_negotiation",
    desk: "sales_manager",
    asks: true,
    patterns: [
      /\b(?:best price|lowest|bottom line|out the door|otd|negotiat\w*|discount|knock\s+(?:off|down)|come down|any deals?|wiggle room)\b/i,
      /\b(?:can|could|would)\s+(?:you|u)\s+(?:do|take|accept)\s+\$?\d/i,
      /\b(?:match|beat)\s+(?:a|the|their|this)\s+(?:price|quote|offer)\b/i,
    ],
  },
  {
    name: "person_request",
    desk: "salesperson",
    asks: true,
    patterns: [
      /\b(?:talk|speak)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:someone|somebody|person|human|real person|manager|salesperson)\b/i,
      /\b(?:real person|a human)\b/i,
    ],
  },
  CONTACT_REQUEST,
];

export const ASKS: readonly RegExp[] = [
  /\b(?:can|could|would|will)\s+(?:you|u|y['’]?all|you guys)\b[^?]{0,100}\?/i,
  /\b(?:are|r)\s+(?:you|u)\s+(?:open|available|free|around|able|still)\b/i,
  /\b(?:is|are)\s+(?:it|this|that|they|the \w+)\s+still\s+(?:there|available|for sale|around|on the lot)\b/i,
  /\bstill\s+(?:there|available|for sale)\s*\?/i,
  /\b(?:when|what time|what day|how soon|how late|how early|how much|how many miles)\b[^?]{0,80}\?/i,
  /\bwhat\s+(?:would|will|does|is|are)\b[^?]{0,80}\?/i,
  /\b(?:do|does)\s+(?:you|u|your\s+(?:store|dealership|lot))\s+(?:have|take|offer|accept|deliver|ship|hold)\b/i,
  /\bplease\s+(?:call|text|send|hold|get back)\b/i,
  /\b(?:cancel|reschedule|push back|move)\s+(?:my|our|the)\s+(?:\w+\s+)?(?:appointment|drive|test drive|visit|time)\b/i,
  /\b(?:can|could|may)\s+i\s+(?:see|come|stop by|drive|test drive|look at|check out|bring)\b/i,
  /(?<!\b(?:if|whether)\s)\b(?:i|we)\s+(?:really\s+|still\s+|do\s+|will\s+)?need\s+(?:a|an|the|it|to)\b/i,
];

export const DECLINES: readonly RegExp[] = [
  /\b(?:already|just)\s+(?:found|got|bought|purchased|picked up|leased)\s+(?:one|a car|a truck|something|elsewhere)\b/i,
  /\b(?:found|bought|got)\s+(?:one|something)\s+(?:else|elsewhere)\b/i,
  /\b(?:not interested|no longer (?:interested|looking))\b/i,
  /\b(?:i['’]?ll|we['’]?ll|i will|we will|going to|gonna)\s+pass\b(?!\s+(?:it|this|that|them|these|those|the word|your|ur|along|on)\b)/i,
  /\bdecided\s+(?:not\s+to|to\s+keep)\b/i,
];

export const NOT_YET: readonly RegExp[] = [
  /\bkeep\s+(?:you|u)\s+in\s+mind\b/i,
  /\b(?:keep|kept|save|saved|saving)\s+(?:your|ur)\s+(?:info|information|number|contact|card|details)\b/i,
  /\b(?:pass|forward|share)\s+(?:it|this|that|the word|your (?:info|information|number|contact))\s+(?:along|on|to)\b/i,
  /\b(?:at a later date|down the road|in the future|next (?:month|year)|in a (?:month|few weeks|couple (?:of )?(?:weeks|months))|not (?:quite )?ready|just (?:looking|browsing))\b/i,
  /\blet\s+me\s+(?:see|check|think|talk)\b/i,
];

export const RULES: Rules = { stop: STOP, possibleStop: POSSIBLE_STOP, triggers: TRIGGERS, asks: ASKS, declines: DECLINES, notYet: NOT_YET };

const any = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

export function readInbound(text: string, rules: Rules = RULES): Reading {
  const plain = { trigger: null, desk: null };
  if (any(rules.stop, text)) return { kind: "stop", asks: false, ...plain };
  if (any(rules.possibleStop, text)) return { kind: "possible_stop", asks: false, trigger: "possible_opt_out", desk: "salesperson" };
  const asks = any(rules.asks, text);
  for (const t of rules.triggers) {
    if (any(t.patterns, text)) {
      return { kind: "handoff", asks: asks || t.asks, trigger: t.name, desk: t.desk };
    }
  }
  if (asks) return { kind: "ask", asks, ...plain };
  if (any(rules.declines, text)) return { kind: "decline", asks, ...plain };
  if (any(rules.notYet, text)) return { kind: "not_yet", asks, ...plain };
  return { kind: "other", asks, ...plain };
}
