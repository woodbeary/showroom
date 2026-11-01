import assert from "node:assert/strict";
import { test } from "node:test";
import { canMove, MOVES, onInbound, STATES } from "../src/journey.ts";

test("the sales path moves forward one legal step at a time", () => {
  const path = ["new", "engaged", "qualified", "vehicle_confirmed", "drive_offered", "booked", "confirmed", "handed_off"] as const;
  for (let i = 1; i < path.length; i++) assert.ok(canMove(path[i - 1]!, path[i]!), `${path[i - 1]} -> ${path[i]}`);
});

test("a lead can't skip to a booking or back to new", () => {
  assert.equal(canMove("engaged", "booked"), false);
  assert.equal(canMove("new", "drive_offered"), false);
  for (const s of STATES) assert.equal(canMove(s, "new"), false, `${s} -> new`);
});

test("handed off and opted out are terminal for the agent", () => {
  for (const s of ["handed_off", "opted_out"] as const) {
    assert.deepEqual(MOVES[s], []);
    for (const t of STATES) assert.equal(canMove(s, t), false, `${s} -> ${t}`);
  }
});

test("every state the agent acts in can hand off and honor a STOP", () => {
  for (const s of STATES) {
    if (s === "handed_off" || s === "opted_out" || s === "closed") continue;
    assert.ok(canMove(s, "handed_off"), s);
    assert.ok(canMove(s, "opted_out"), s);
  }
});

test("a customer writing in moves new and closed leads to engaged", () => {
  assert.deepEqual(onInbound("new"), ["new", "engaged"]);
  assert.deepEqual(onInbound("closed"), ["closed", "engaged"]);
  assert.deepEqual(onInbound("booked"), ["booked"]);
});
