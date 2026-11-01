import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ROOT } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "showroom-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const showroom = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "src", "cli.ts"), ...args], { encoding: "utf8", cwd: ROOT });

test("showroom run prints the README's demo", () => {
  const out = showroom("run", "examples/lead-0952pm.json", "--queue", join(dir, "outbox.jsonl"));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /decidedAt Wed 2026-11-04 9:52 pm {2}\(quiet hours 21:00-08:00\)/);
  assert.match(out.stdout, /state {5}new -> engaged -> drive_offered/);
  assert.match(out.stdout, /queued for Thu 2026-11-05 8:00 am/);
  assert.match(out.stdout, /HELD {6}no_payment_terms: "credit", "a month"/);
  assert.match(out.stdout, /handoff {3}finance desk \(check: no_payment_terms\)/);
  assert.equal(readFileSync(join(dir, "outbox.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("showroom backtest exits 0 with every fixture passing and writes the gate files", () => {
  const out = showroom("backtest", "examples/transcripts", "--gate", join(dir, "gate"));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Regression fixtures: 24 of 24 pass\./);
  assert.match(out.stdout, /label \\ agent/);
  const labels = readFileSync(join(dir, "gate", "labels.jsonl"), "utf8").trim().split("\n");
  assert.ok(labels.every((l) => JSON.parse(l).decision.decidedBy === "human"));
});

test("a STOP after the 9:52 pm reply was queued: the 8:00 am cycle holds the reply and delivers nothing", () => {
  const spec = JSON.parse(readFileSync(join(ROOT, "examples", "lead-0952pm.json"), "utf8"));
  const lead = join(dir, "stop-lead.json");
  writeFileSync(lead, JSON.stringify({ ...spec, turns: [spec.turns[0], { decidedAt: "2026-11-04T22:30:00-08:00", customer: "STOP" }] }));
  const queue = join(dir, "stop-outbox.jsonl");
  const ran = showroom("run", lead, "--queue", queue);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /state {5}drive_offered -> opted_out/);
  assert.equal(readFileSync(queue, "utf8").trim().split("\n").length, 2);
  const switchFile = join(dir, "stop-switch.txt");
  showroom("switch", switchFile, "on");
  const provider = join(dir, "stop-provider.jsonl");
  const sent = showroom("send", queue, "--ledger", join(dir, "stop-ledger.jsonl"), "--switch", switchFile, "--provider", provider, "--live", "--now", "2026-11-05T08:00:00-08:00");
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /held +stop_honored: the customer opted out/);
  assert.equal(existsSync(provider), false);
});

test("bad input exits 2 with a message", () => {
  const out = showroom("run", join(dir, "missing.json"));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /showroom: /);
});
