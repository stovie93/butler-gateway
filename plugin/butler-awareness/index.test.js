import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNow, relativeLabel, buildAwareness } from "./index.js";

test("formatNow renders a readable 12h timestamp", () => {
  const s = formatNow(new Date(2026, 5, 30, 15, 47)); // 30 June 2026, 3:47 PM
  assert.equal(s, "Tuesday, 30 June 2026, 3:47 PM");
});

test("formatNow handles midnight and noon", () => {
  assert.match(formatNow(new Date(2026, 0, 1, 0, 5)), /12:05 AM$/);
  assert.match(formatNow(new Date(2026, 0, 1, 12, 0)), /12:00 PM$/);
});

test("relativeLabel summarizes future offsets", () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeLabel(now, now), "now");
  assert.equal(relativeLabel(now + 5 * 60_000, now), "in 5m");
  assert.equal(relativeLabel(now + (2 * 3600 + 10 * 60) * 1000, now), "in 2h 10m");
});

test("buildAwareness always includes the clock", () => {
  const out = buildAwareness({ now: new Date(2026, 5, 30, 9, 0) });
  assert.match(out, /# Right now/);
  assert.match(out, /Tuesday, 30 June 2026/);
  assert.doesNotMatch(out, /# On Jordan's PC/); // no state → section omitted
  assert.doesNotMatch(out, /auto-recalled/);
});

test("buildAwareness surfaces jobs, reminders, and memories when present", () => {
  const now = new Date(2026, 5, 30, 9, 0);
  const out = buildAwareness({
    now,
    jobs: [{ project: "snake-highscore", task: "build a snake game" }],
    reminders: [{ text: "call mum", fireAt: now.getTime() + 60 * 60_000 }],
    memories: ["Jordan's GitHub username is stovie93", "He prefers concise replies"],
  });
  assert.match(out, /A build is running: snake-highscore\./);
  assert.match(out, /1 reminder pending; next: "call mum" in 1h\./);
  assert.match(out, /auto-recalled for his latest message/);
  assert.match(out, /Jordan's GitHub username is stovie93/);
});
