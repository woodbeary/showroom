import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  assert.match(out.stdout, /Regression fixtures: 11 of 11 pass\./);
  assert.match(out.stdout, /label \\ agent/);
  const labels = readFileSync(join(dir, "gate", "labels.jsonl"), "utf8").trim().split("\n");
  assert.ok(labels.every((l) => JSON.parse(l).decision.decidedBy === "human"));
});

test("bad input exits 2 with a message", () => {
  const out = showroom("run", join(dir, "missing.json"));
  assert.equal(out.status, 2);
  assert.match(out.stderr, /showroom: /);
});
