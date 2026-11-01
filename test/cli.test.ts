import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(out.stdout, /Routed to the named desk on 74 of 90 \(82\.2%\)\./);
  assert.match(out.stdout, /\nappraisal +20 +11 +0 +11 +0 +0 +2 +7\n/);
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

test("the stand-in is the default: no model call is timed and the gate export carries no latency or error", () => {
  const out = showroom("backtest", "examples/transcripts", "--gate", join(dir, "gate-default"));
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /Shadow model/);
  const shadow = readFileSync(join(dir, "gate-default", "shadow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(shadow.length, 464);
  assert.ok(shadow.every((s) => s.latency_s === null && s.error === null));
});

const offline = (): NodeJS.ProcessEnv => {
  const { ANTHROPIC_API_KEY: _a, ANTHROPIC_AUTH_TOKEN: _t, ANTHROPIC_PROFILE: _p, OPENAI_API_KEY: _o, OPENAI_ADMIN_KEY: _oa, ...env } = process.env;
  const home = join(dir, "empty-home");
  mkdirSync(home, { recursive: true });
  return { ...env, HOME: home, ANTHROPIC_BASE_URL: "http://127.0.0.1:9", OPENAI_BASE_URL: "http://127.0.0.1:9" };
};

const offlineShowroom = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, "src", "cli.ts"), ...args], { encoding: "utf8", cwd: ROOT, env: offline() });

test("a real model runs only in backtest, in shadow, and says what it needs", () => {
  const run = offlineShowroom("run", "examples/lead-0952pm.json", "--model", "claude");
  assert.equal(run.status, 2);
  assert.match(run.stderr, /a real model runs only in shadow, never toward an outbox/);
  const send = offlineShowroom("send", join(dir, "none.jsonl"), "--ledger", join(dir, "l"), "--switch", join(dir, "s"), "--model", "claude");
  assert.equal(send.status, 2);
  const noId = offlineShowroom("backtest", "examples/transcripts", "--model", "openai");
  assert.equal(noId.status, 2);
  assert.match(noId.stderr, /must name the model; there is no default/);
  const noKey = offlineShowroom("backtest", "examples/transcripts", "--model", "openai:test-model");
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /needs OPENAI_API_KEY/);
  const effort = offlineShowroom("backtest", "examples/transcripts", "--model", "claude", "--effort", "extreme");
  assert.equal(effort.status, 2);
  assert.match(effort.stderr, /--effort must be one of low, medium, high, xhigh, max/);
});

test("a shadow run where every model call fails says so and exits 1, without leaving the machine", () => {
  const out = offlineShowroom("backtest", "examples/transcripts", "--model", "claude", "--threads", "1", "--concurrency", "1", "--gate", join(dir, "gate-failed"));
  assert.equal(out.status, 1);
  assert.match(out.stdout, /Shadow model claude:claude-opus-5-5: 2 timed calls, 2 errors, p95 decision time/);
  assert.match(out.stderr, /every call to claude:claude-opus-5-5 failed; first error: model_error: /);
  const shadow = readFileSync(join(dir, "gate-failed", "shadow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const timed = shadow.filter((s) => s.latency_s !== null);
  assert.equal(timed.length, 2);
  assert.ok(timed.every((s) => typeof s.latency_s === "number" && /^model_error: /.test(s.error)));
  assert.ok(shadow.filter((s) => s.latency_s === null).every((s) => s.error === null));
});

test("bad input exits 2 with a message", () => {
  const out = showroom("run", join(dir, "missing.json"));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /showroom: /);
});
