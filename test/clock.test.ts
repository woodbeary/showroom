import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, earliestSend, inQuietHours, localTime, sameLocalDay, zonedInstant } from "../src/clock.ts";
import { store } from "./helpers.ts";

const tz = store.timeZone;
const q = store.quietHours;

test("a 9:52 pm message is answered at 8:00 the next morning, store time", () => {
  const at = new Date("2026-11-04T21:52:00-08:00");
  assert.equal(inQuietHours(at, q, tz), true);
  assert.equal(earliestSend(at, q, tz).toISOString(), "2026-11-05T16:00:00.000Z");
  assert.equal(describe(earliestSend(at, q, tz), tz), "Thu 2026-11-05 8:00 am");
});

test("a 3 am message waits for 8:00 the same day; a noon message goes now", () => {
  assert.equal(earliestSend(new Date("2026-11-05T03:10:00-08:00"), q, tz).toISOString(), "2026-11-05T16:00:00.000Z");
  const noon = new Date("2026-11-05T12:00:00-08:00");
  assert.equal(earliestSend(noon, q, tz).getTime(), noon.getTime());
});

test("quiet hours follow the store's clock across the November DST change", () => {
  const sat = new Date("2026-10-31T21:30:00-07:00");
  assert.equal(earliestSend(sat, q, tz).toISOString(), "2026-11-01T16:00:00.000Z");
  assert.equal(localTime(new Date("2026-11-01T16:00:00Z"), tz).hour, 8);
  assert.equal(inQuietHours(new Date("2026-11-01T15:30:00Z"), q, tz), true);
});

test("the quiet window's edges: 8:00 is open and 21:00 is quiet", () => {
  assert.equal(inQuietHours(zonedInstant(2026, 11, 5, 8, 0, tz), q, tz), false);
  assert.equal(inQuietHours(zonedInstant(2026, 11, 5, 7, 59, tz), q, tz), true);
  assert.equal(inQuietHours(zonedInstant(2026, 11, 5, 21, 0, tz), q, tz), true);
  assert.equal(inQuietHours(zonedInstant(2026, 11, 5, 20, 59, tz), q, tz), false);
});

test("local days are compared in the store's time zone, not UTC", () => {
  assert.equal(sameLocalDay(new Date("2026-11-05T07:00:00Z"), new Date("2026-11-04T09:00:00Z"), tz), true);
  assert.equal(sameLocalDay(new Date("2026-11-05T05:52:00Z"), new Date("2026-11-05T16:00:00Z"), tz), false);
});
