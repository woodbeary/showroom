import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { armScore, assignArm } from "../src/holdout.ts";
import { EX, ROOT } from "./helpers.ts";

test("assignment matches the shared vectors the Python readout also checks", () => {
  const vectors = JSON.parse(readFileSync(join(ROOT, "test", "vectors", "assignment.json"), "utf8"));
  for (const v of vectors) {
    assert.equal(assignArm(v.leadId, v.salt, v.holdoutShare), v.arm, v.leadId);
    assert.ok(Math.abs(armScore(v.leadId, v.salt) - v.score) < 1e-9, v.leadId);
  }
});

test("a 20% holdout lands near 20% and is stable for the same lead", () => {
  let held = 0;
  for (let i = 0; i < 20000; i++) if (assignArm(`lead-${i}`, "s", 0.2) === "holdout") held++;
  assert.ok(held > 3800 && held < 4200, String(held));
  assert.equal(assignArm("lead-7", "s", 0.2), assignArm("lead-7", "s", 0.2));
});

test("a new salt reshuffles, and a missing salt or a bad share is refused", () => {
  const ids = Array.from({ length: 500 }, (_, i) => `L-${i}`);
  const moved = ids.filter((id) => assignArm(id, "a", 0.2) !== assignArm(id, "b", 0.2)).length;
  assert.ok(moved > 100, String(moved));
  assert.throws(() => assignArm("x", "", 0.2), /salt/);
  assert.throws(() => assignArm("x", "s", 1), /holdoutShare/);
});

test("every enrolled lead in the example was assigned by the hash", () => {
  const prereg = JSON.parse(readFileSync(join(EX, "experiment", "preregistration.json"), "utf8"));
  const rows = readFileSync(join(EX, "experiment", "leads.csv"), "utf8").trim().split("\n").slice(1);
  let enrolled = 0;
  for (const row of rows) {
    const [id, , arm] = row.split(",");
    if (!arm) continue;
    enrolled++;
    assert.equal(arm, assignArm(id!, prereg.assignment.salt, prereg.assignment.holdoutShare), id);
  }
  assert.equal(enrolled, 2000);
});
