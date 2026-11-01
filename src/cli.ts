#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateExport, loadBacktestDir, backtestThread, runFixtures, summarize, ACTIONS, type Report, type Tag } from "./backtest.ts";
import { describe, inQuietHours, parseInstant } from "./clock.ts";
import { DESK_NAMES } from "./intent.ts";
import { scripted, type Proposal } from "./model.ts";
import { Ledger, FileSender, cycle, type CrashPoint } from "./send.ts";
import { routineModel } from "./standin.ts";
import { loadInventory, loadStore, lookupVehicle, readJson, type Store, type Vehicle } from "./store.ts";
import { turn, type Lead, type TurnResult } from "./turn.ts";

const EXAMPLES = resolve(import.meta.dirname, "..", "examples");

const USAGE = `showroom: run a sales agent like a product

  showroom run <lead.json> [--queue outbox.jsonl] [--json]
  showroom backtest <dir> [--gate <outdir>] [--json]
  showroom send <outbox.jsonl> --ledger <file> --switch <file> [--live] [--now <iso>]
  showroom switch <file> on|off

  --store <store.json>          default examples/store.json
  --inventory <inventory.json>  default examples/inventory.json
`;

class UsageError extends Error {}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

interface LeadFile {
  lead: Lead;
  model: string;
  turns: { decidedAt: string; customer: string; proposal: Proposal }[];
}

function printTurn(n: number, customer: string, r: TurnResult, store: Store): void {
  const at = parseInstant(r.decidedAt, "decidedAt");
  const quiet = inQuietHours(at, store.quietHours, store.timeZone);
  console.log(`turn ${n}  decidedAt ${describe(at, store.timeZone)}${quiet ? `  (quiet hours ${store.quietHours.start}-${store.quietHours.end})` : ""}`);
  console.log(`  customer  ${customer}`);
  const k = r.reading;
  console.log(`  reading   ${k.kind}${k.asks && k.kind !== "ask" ? " (asks)" : ""}${k.trigger ? `: ${k.trigger}` : ""}`);
  if (r.proposal?.draft) console.log(`  draft     ${r.proposal.draft}`);
  for (const h of r.holds) console.log(`  HELD      ${h.check}: ${h.detail}`);
  console.log(`  state     ${r.path.join(" -> ")}`);
  if (r.handoff) console.log(`  handoff   ${DESK_NAMES[r.handoff.desk]} (${r.handoff.by}: ${r.handoff.reason})`);
  if (r.sendAt) {
    const send = parseInstant(r.sendAt, "sendAt");
    const when = send.getTime() === at.getTime() ? "now" : `queued for ${describe(send, store.timeZone)}, when quiet hours end`;
    console.log(`  sends     ${when}`);
  }
  console.log(`  reply     ${r.text ?? `(none: ${r.action})`}`);
}

async function cmdRun(file: string, opts: { store: Store; inventory: Vehicle[]; queue?: string; json: boolean }): Promise<number> {
  const spec = readJson(file) as LeadFile;
  const model = scripted(spec.model, spec.turns.map((t) => t.proposal));
  let lead: Lead = spec.lead;
  const vehicle = lookupVehicle(opts.inventory, lead.stock);
  const results: TurnResult[] = [];
  if (!opts.json) {
    const v = vehicle ? `${vehicle.title} (${vehicle.stock}), listed $${vehicle.price.toLocaleString("en-US")}, ${vehicle.status}` : "no vehicle on file";
    console.log(`${lead.id}  ${v}`);
    console.log(`model: ${spec.model}\n`);
  }
  for (const [i, t] of spec.turns.entries()) {
    const out = await turn({ lead, text: t.customer, decidedAt: t.decidedAt, store: opts.store, inventory: opts.inventory, model });
    lead = out.lead;
    results.push(out.result);
    if (!opts.json) {
      printTurn(i + 1, t.customer, out.result, opts.store);
      console.log("");
    }
    if (opts.queue && out.result.text) appendFileSync(opts.queue, `${JSON.stringify(out.result)}\n`);
  }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else console.log(`final state: ${lead.state}`);
  return 0;
}

function printReport(r: Report): void {
  const agree = r.scored.filter((p) => !p.tag).length;
  console.log(`${r.threads} threads, ${r.points.length} customer messages.`);
  console.log(`Scored ${r.scored.length} against what happened next; agreed on ${agree} (${((100 * agree) / Math.max(1, r.scored.length)).toFixed(1)}%).`);
  console.log(`Not scored: ${r.unscored.agent_authored} where the agent wrote the next step (never a label), ${r.unscored.person_owned} after a person took the lead, ${r.unscored.unknown} with no outcome yet.\n`);
  console.log(`label \\ agent   ${ACTIONS.map((a) => lpad(a, 9)).join("")}`);
  for (const l of ACTIONS) console.log(`${pad(l, 16)}${ACTIONS.map((a) => lpad(r.confusion[l][a], 9)).join("")}`);
  console.log(`\nBy journey state when the customer wrote:`);
  console.log(`${pad("state", 18)}${lpad("n", 5)}${lpad("agree", 7)}  failure modes`);
  for (const s of r.byState) {
    const tags = Object.entries(s.tags).map(([t, n]) => `${t} ${n}`).join(", ");
    console.log(`${pad(s.state, 18)}${lpad(s.n, 5)}${lpad(s.agree, 7)}  ${tags}`.trimEnd());
  }
  console.log(`\nFailure modes:`);
  for (const [tag, pts] of Object.entries(r.tags) as [Tag, Report["points"]][]) {
    console.log(`  ${pad(tag, 16)}${lpad(pts.length, 4)}  e.g. ${pts.slice(0, 2).map((p) => `${p.id} "${p.text}"`).join("; ")}`);
  }
  if (r.held) console.log(`\nPre-send checks held ${r.held} drafts; each became a handoff.`);
  if (r.fixtures.length) {
    const failed = r.fixtures.filter((f) => !f.passed);
    console.log(`\nRegression fixtures: ${r.fixtures.length - failed.length} of ${r.fixtures.length} pass.`);
    for (const f of failed) {
      console.log(`  FAIL ${f.fixture.id} "${f.fixture.text}" expected ${JSON.stringify(f.fixture.expect)}, got ${JSON.stringify(f.got)}`);
    }
  }
}

async function cmdBacktest(dir: string, opts: { store: Store; inventory: Vehicle[]; gate?: string; json: boolean }): Promise<number> {
  const { threads, fixtures } = loadBacktestDir(dir);
  const model = routineModel();
  const points = (await Promise.all(threads.map((t) => backtestThread(t, model, opts.store, opts.inventory)))).flat();
  const fixtureVehicle = opts.inventory.find((v) => v.status === "available");
  if (!fixtureVehicle) throw new UsageError("fixtures need one available vehicle in the inventory");
  const report = summarize(threads.length, points, await runFixtures(fixtures, model, opts.store, fixtureVehicle));
  if (opts.json) {
    const { points: _p, scored: _s, tags, ...rest } = report;
    const tagCounts = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, v.length]));
    console.log(JSON.stringify({ ...rest, points: report.points.length, scored: report.scored.length, tags: tagCounts }, null, 2));
  } else printReport(report);
  if (opts.gate) {
    mkdirSync(opts.gate, { recursive: true });
    const lastAt = points.reduce((m, p) => (p.at > m ? p.at : m), "");
    const { shadow, labels } = gateExport(points, `showroom ${model.name}`, lastAt);
    writeFileSync(join(opts.gate, "shadow.jsonl"), shadow.map((l) => JSON.stringify(l)).join("\n") + "\n");
    writeFileSync(join(opts.gate, "labels.jsonl"), labels.map((l) => JSON.stringify(l)).join("\n") + "\n");
    if (!opts.json) console.log(`\nWrote ${shadow.length} agent decisions and ${labels.length} human labels to ${opts.gate}/ in autonomy-gate's format.`);
  }
  return report.fixtures.every((f) => f.passed) ? 0 : 1;
}

async function cmdSend(file: string, v: Record<string, string | boolean | undefined>, store: Store): Promise<number> {
  if (typeof v.ledger !== "string" || typeof v.switch !== "string") throw new UsageError("send needs --ledger and --switch");
  const queue = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as TurnResult);
  const crash = (process.env.SHOWROOM_DEMO_CRASH ?? null) as CrashPoint | null;
  const sender = new FileSender(typeof v.provider === "string" ? v.provider : `${v.ledger}.provider.jsonl`, crash);
  const lines = await cycle(queue, {
    mode: v.live ? "live" : "shadow",
    ledger: new Ledger(v.ledger),
    switchPath: v.switch,
    sender,
    store,
    now: typeof v.now === "string" ? parseInstant(v.now, "--now") : new Date(),
  });
  for (const l of lines) console.log(`  ${pad(l.requestId, 42)}${pad(l.outcome, 32)}${l.detail}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      store: { type: "string", default: join(EXAMPLES, "store.json") },
      inventory: { type: "string", default: join(EXAMPLES, "inventory.json") },
      queue: { type: "string" },
      gate: { type: "string" },
      json: { type: "boolean", default: false },
      ledger: { type: "string" },
      switch: { type: "string" },
      provider: { type: "string" },
      live: { type: "boolean", default: false },
      now: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg, extra] = positionals;
  if (v.help || !cmd) {
    console.log(USAGE);
    return v.help ? 0 : 2;
  }
  const store = loadStore(v.store as string);
  const inventory = loadInventory(v.inventory as string);
  const json = Boolean(v.json);
  if (cmd === "run" && arg) return cmdRun(arg, { store, inventory, json, ...(v.queue ? { queue: v.queue } : {}) });
  if (cmd === "backtest" && arg) return cmdBacktest(arg, { store, inventory, json, ...(v.gate ? { gate: v.gate } : {}) });
  if (cmd === "send" && arg) return cmdSend(arg, v, store);
  if (cmd === "switch" && arg && (extra === "on" || extra === "off")) {
    writeFileSync(arg, extra === "on" ? "on\n" : "stop\n");
    console.log(`${arg}: ${extra === "on" ? "on" : "stop"}`);
    return 0;
  }
  throw new UsageError(USAGE);
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(error instanceof UsageError ? error.message : `showroom: ${error.message}`);
      process.exit(2);
    },
  );
}
