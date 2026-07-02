import { test } from "node:test";
import assert from "node:assert/strict";
import { inQuietHours, isDue, parseAt, parseEvery, shouldDeliver } from "./index.js";

test("parseAt handles 24h, am/pm, and rejects garbage", () => {
  assert.deepEqual(parseAt("08:00"), { h: 8, min: 0 });
  assert.deepEqual(parseAt("8am"), { h: 8, min: 0 });
  assert.deepEqual(parseAt("9:30pm"), { h: 21, min: 30 });
  assert.deepEqual(parseAt("12am"), { h: 0, min: 0 });
  assert.deepEqual(parseAt("12pm"), { h: 12, min: 0 });
  assert.equal(parseAt("25:00"), null);
  assert.equal(parseAt("13pm"), null);
  assert.equal(parseAt("soonish"), null);
  assert.equal(parseAt(""), null);
});

test("parseEvery handles minutes/hours/days and rejects garbage", () => {
  assert.equal(parseEvery("90m"), 90 * 60_000);
  assert.equal(parseEvery("2h"), 2 * 3_600_000);
  assert.equal(parseEvery("45 mins"), 45 * 60_000);
  assert.equal(parseEvery("1 day"), 86_400_000);
  assert.equal(parseEvery("0h"), null);
  assert.equal(parseEvery("often"), null);
});

test("inQuietHours handles plain and midnight-wrapping windows", () => {
  const quiet = { start: "22:00", end: "08:00" };
  assert.equal(inQuietHours(new Date(2026, 6, 1, 23, 0), quiet), true);
  assert.equal(inQuietHours(new Date(2026, 6, 1, 3, 0), quiet), true);
  assert.equal(inQuietHours(new Date(2026, 6, 1, 12, 0), quiet), false);
  assert.equal(inQuietHours(new Date(2026, 6, 1, 8, 0), quiet), false); // end is exclusive
  const day = { start: "09:00", end: "17:00" };
  assert.equal(inQuietHours(new Date(2026, 6, 1, 12, 0), day), true);
  assert.equal(inQuietHours(new Date(2026, 6, 1, 20, 0), day), false);
  assert.equal(inQuietHours(new Date(2026, 6, 1, 12, 0), null), false);
});

test("isDue: 'at' entries fire once per day within the catch-up window", () => {
  const entry = { id: "x", at: "08:00", prompt: "p" };
  const today8 = new Date(2026, 6, 1, 8, 0).getTime();
  // Before schedule: not due.
  assert.equal(isDue(entry, 0, new Date(2026, 6, 1, 7, 59), null), false);
  // Just after, never run today: due.
  assert.equal(isDue(entry, 0, new Date(2026, 6, 1, 8, 1), null), true);
  // Ran yesterday: still due today.
  assert.equal(isDue(entry, today8 - 86_400_000, new Date(2026, 6, 1, 8, 1), null), true);
  // Already ran today: not due.
  assert.equal(isDue(entry, today8 + 60_000, new Date(2026, 6, 1, 9, 0), null), false);
  // Way past the catch-up window (PC slept through it): skipped.
  assert.equal(isDue(entry, 0, new Date(2026, 6, 1, 15, 0), null), false);
  // Disabled entries never fire.
  assert.equal(isDue({ ...entry, enabled: false }, 0, new Date(2026, 6, 1, 8, 1), null), false);
});

test("isDue: 'every' entries respect the interval and quiet hours", () => {
  const entry = { id: "y", every: "2h", mode: "decide", prompt: "p" };
  const now = new Date(2026, 6, 1, 12, 0);
  assert.equal(isDue(entry, now.getTime() - 3 * 3_600_000, now, null), true);
  assert.equal(isDue(entry, now.getTime() - 3_600_000, now, null), false);
  // Quiet hours suppress interval beats.
  const night = new Date(2026, 6, 1, 23, 30);
  assert.equal(isDue(entry, 0, night, { start: "22:00", end: "08:00" }), false);
  // Malformed schedule never fires.
  assert.equal(isDue({ id: "z", every: "whenever", prompt: "p" }, 0, now, null), false);
  assert.equal(isDue({ id: "w", prompt: "p" }, 0, now, null), false);
});

test("shouldDeliver: decide-mode HEARTBEAT_OK stays silent, always-mode speaks", () => {
  assert.equal(shouldDeliver("HEARTBEAT_OK", "decide").deliver, false);
  assert.equal(shouldDeliver("  heartbeat_ok.  ", "decide").deliver, false);
  assert.equal(shouldDeliver("Jordan, the build failed!", "decide").deliver, true);
  assert.equal(shouldDeliver("Good morning!", "always").deliver, true);
  assert.equal(shouldDeliver("", "always").deliver, false);
  assert.equal(shouldDeliver(null, "decide").deliver, false);
  // Defaults to decide-mode when mode is missing.
  assert.equal(shouldDeliver("HEARTBEAT_OK", undefined).deliver, false);
  // Long replies get capped for the push.
  const long = shouldDeliver("x".repeat(2000), "always");
  assert.equal(long.deliver, true);
  assert.ok(long.body.length <= 1000);
});
