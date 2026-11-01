import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { scripted, type Proposal } from "../src/model.ts";
import { cycle, Ledger, type CycleOptions, type Sender } from "../src/send.ts";
import { HANDOFF_COPY, turn, type Lead, type TurnResult } from "../src/turn.ts";
import { crossover, inventory, ROOT, store } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "showroom-send-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `case-${++n}`);

const item = (over: Partial<TurnResult> = {}): TurnResult => ({
  writtenBy: "showroom",
  leadId: "lead-s",
  decidedAt: "2026-11-05T12:00:00-08:00",
  sendAt: "2026-11-05T20:00:00.000Z",
  path: ["engaged", "drive_offered"],
  action: "reply",
  text: "Thursday at 5:30 pm or 6:15 pm?",
  reading: { kind: "ask", asks: true, trigger: null, desk: null },
  model: "test",
  proposal: null,
  holds: [],
  handoff: null,
  ...over,
});

function counting(): Sender & { sends: number } {
  const sent = new Map<string, string>();
  return {
    sends: 0,
    async send(id) {
      this.sends++;
      sent.set(id, `r-${this.sends}`);
      return `r-${this.sends}`;
    },
    async lookup(id) {
      return sent.get(id) ?? null;
    },
  };
}

function opts(base: string, over: Partial<CycleOptions> = {}): CycleOptions {
  return { mode: "live", ledger: new Ledger(`${base}.ledger`), switchPath: `${base}.switch`, sender: null, store, now: new Date("2026-11-05T13:00:00-08:00"), ...over };
}

test("with the switch on, a due reply is written as sending, then sent once", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const sender = counting();
  const lines = await cycle([item()], opts(base, { sender }));
  assert.deepEqual(lines.map((l) => l.outcome), ["sent"]);
  const rows = readFileSync(`${base}.ledger`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.state), ["sending", "sent"]);
  assert.ok(rows.every((r) => r.writtenBy === "showroom"));
  await cycle([item()], opts(base, { sender }));
  assert.equal(sender.sends, 1);
});

test("the kill switch is read every cycle: missing or 'stop' holds everything", async () => {
  const base = fresh();
  const sender = counting();
  assert.equal((await cycle([item()], opts(base, { sender })))[0]?.outcome, "held");
  writeFileSync(`${base}.switch`, "stop\n");
  assert.equal((await cycle([item({ leadId: "lead-2" })], opts(base, { sender })))[0]?.outcome, "held");
  assert.equal(sender.sends, 0);
});

test("shadow mode logs and never calls the sender, even with the switch on", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const sender = counting();
  const lines = await cycle([item()], opts(base, { mode: "shadow", sender }));
  assert.equal(lines[0]?.outcome, "shadowed");
  assert.equal(sender.sends, 0);
});

test("nothing goes out before its send time or during quiet hours", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const sender = counting();
  assert.equal((await cycle([item()], opts(base, { sender, now: new Date("2026-11-05T11:00:00-08:00") })))[0]?.outcome, "not_due");
  assert.equal((await cycle([item()], opts(base, { sender, now: new Date("2026-11-05T22:00:00-08:00") })))[0]?.outcome, "quiet_hours");
  assert.equal(sender.sends, 0);
});

test("a send that raises is settled by lookup, never by sending again", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  let sends = 0;
  const flaky: Sender = {
    async send() {
      sends++;
      throw new Error("socket hang up");
    },
    async lookup() {
      return null;
    },
  };
  const lines = await cycle([item()], opts(base, { sender: flaky }));
  assert.equal(lines[0]?.outcome, "unconfirmed_never_resubmitted");
  await cycle([item()], opts(base, { sender: flaky }));
  assert.equal(sends, 1);
});

async function nightThenLater(text: string, at: string, then: Proposal[] = []): Promise<TurnResult[]> {
  const model = scripted("test", [
    { next: "drive_offered", slots: ["2026-11-05T17:30:00-08:00", "2026-11-05T18:15:00-08:00"], draft: "It's still here. Thursday at 5:30 pm or 6:15 pm?" },
    ...then,
  ]);
  const lead: Lead = { id: "lead-n", stock: crossover.stock, state: "new", thread: [], offeredSlots: [] };
  const first = await turn({ lead, text: "is it still there?", decidedAt: "2026-11-04T21:52:00-08:00", store, inventory, model });
  const second = await turn({ lead: first.lead, text, decidedAt: at, store, inventory, model });
  return [first.result, second.result];
}

test("a STOP after a reply was queued for quiet hours holds that reply when it comes due", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const sender = counting();
  const queue = await nightThenLater("STOP", "2026-11-04T22:30:00-08:00");
  assert.equal(queue[0]?.sendAt, "2026-11-05T16:00:00.000Z");
  const lines = await cycle(queue, opts(base, { sender, now: new Date("2026-11-05T08:00:00-08:00") }));
  assert.deepEqual(lines.map((l) => l.outcome), ["held"]);
  assert.match(lines[0]?.detail ?? "", /^stop_honored: /);
  assert.equal(sender.sends, 0);
});

test("a STOP holds a queued reply at once, before it is due, and in shadow mode too", async () => {
  const queue = await nightThenLater("unsubscribe", "2026-11-04T22:30:00-08:00");
  const live = await cycle(queue, opts(fresh(), { now: new Date("2026-11-04T23:00:00-08:00") }));
  assert.equal(live[0]?.outcome, "held");
  const shadow = await cycle(queue, opts(fresh(), { mode: "shadow", now: new Date("2026-11-05T08:00:00-08:00") }));
  assert.equal(shadow[0]?.outcome, "held");
});

test("a handoff after a reply was queued holds the reply for the person, and the handoff line still goes", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const texts: string[] = [];
  const sender: Sender = {
    async send(_id, _lead, text) {
      texts.push(text);
      return `r-${texts.length}`;
    },
    async lookup() {
      return null;
    },
  };
  const queue = await nightThenLater("what would my monthly payment be?", "2026-11-05T07:30:00-08:00");
  assert.equal(queue[1]?.handoff?.desk, "finance");
  const lines = await cycle(queue, opts(base, { sender, now: new Date("2026-11-05T08:00:00-08:00") }));
  assert.deepEqual(lines.map((l) => l.outcome), ["held", "sent"]);
  assert.match(lines[0]?.detail ?? "", /^owner: a person took the lead/);
  assert.deepEqual(texts, [HANDOFF_COPY]);
});

test("a later turn that leaves the lead with the agent does not hold an earlier reply", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const sender = counting();
  const queue = await nightThenLater("thanks!", "2026-11-04T22:30:00-08:00", [{ next: "drive_offered", draft: null }]);
  assert.equal(queue[1]?.action, "no_reply");
  const lines = await cycle(queue, opts(base, { sender, now: new Date("2026-11-05T08:00:00-08:00") }));
  assert.deepEqual(lines.map((l) => l.outcome), ["sent"]);
  assert.equal(sender.sends, 1);
});

test("a reply that says 'today' is held when it would go out on a later day than it was decided", async () => {
  const base = fresh();
  writeFileSync(`${base}.switch`, "on\n");
  const sender = counting();
  const today = item({ text: "I can do today at 5:30 pm." });
  const late = await cycle([today], opts(base, { sender, now: new Date("2026-11-06T09:00:00-08:00") }));
  assert.equal(late[0]?.outcome, "held");
  assert.match(late[0]?.detail ?? "", /^day_words_match_send_day: /);
  assert.equal(sender.sends, 0);
  const onTime = await cycle([item({ leadId: "lead-t2", text: "I can do today at 5:30 pm." })], opts(base, { sender, now: new Date("2026-11-05T13:00:00-08:00") }));
  assert.equal(onTime[0]?.outcome, "sent");
  assert.equal(sender.sends, 1);
});

const deliveries = (base: string) =>
  readFileSync(`${base}.provider`, { encoding: "utf8", flag: "a+" }).split("\n").filter((l) => l.trim()).length;

function runSend(base: string, crash?: string) {
  return spawnSync(process.execPath, [join(ROOT, "src", "cli.ts"), "send", `${base}.queue`, "--ledger", `${base}.ledger`, "--switch", `${base}.switch`, "--provider", `${base}.provider`, "--live", "--now", "2026-11-05T13:00:00-08:00"], {
    encoding: "utf8",
    env: { ...process.env, ...(crash ? { SHOWROOM_DEMO_CRASH: crash } : {}) },
  });
}

for (const [crash, settled, delivered] of [
  ["before_write", "unconfirmed_never_resubmitted", 0],
  ["after_write", "sent", 1],
] as const) {
  test(`a process killed ${crash.replace("_", " ")} inside send() is not sent twice`, () => {
    const base = fresh();
    writeFileSync(`${base}.switch`, "on\n");
    writeFileSync(`${base}.queue`, `${JSON.stringify(item())}\n`);
    const died = runSend(base, crash);
    assert.equal(died.status, 137);
    const restarted = runSend(base);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, new RegExp(settled));
    assert.equal(deliveries(base), delivered);
    runSend(base);
    assert.equal(deliveries(base), delivered);
  });
}
