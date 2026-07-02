import { test } from "node:test";
import assert from "node:assert/strict";
import { capText, extractEscalation, publicRecord, validateQuestion } from "./index.js";

test("extractEscalation catches explicit hand-off intents only", () => {
  assert.ok(extractEscalation("can you ask Claude why the sky is blue?"));
  assert.ok(extractEscalation("hand this to claude please"));
  assert.ok(extractEscalation("run it by the big brain"));
  assert.ok(extractEscalation("Escalate to your cloud brain"));
  assert.ok(extractEscalation("check with Claude before we decide"));
  assert.ok(!extractEscalation("what do you know about Claude Debussy?"));
  assert.ok(!extractEscalation("ask me anything"));
  assert.ok(!extractEscalation("why is the sky blue?"));
  assert.ok(!extractEscalation(null));
});

test("validateQuestion trims, collapses whitespace, and bounds length", () => {
  const v = validateQuestion("  why   is\n the sky blue?  ");
  assert.deepEqual(v, { ok: true, question: "why is the sky blue?" });
  assert.equal(validateQuestion("").ok, false);
  assert.equal(validateQuestion("hi").ok, false);
  assert.equal(validateQuestion("x".repeat(2001)).ok, false);
  assert.equal(validateQuestion("x".repeat(2000)).ok, true);
});

test("capText caps once with an ellipsis and trims", () => {
  assert.equal(capText("short", 10), "short");
  const capped = capText("a".repeat(20), 10);
  assert.equal(capped.length, 10);
  assert.ok(capped.endsWith("…"));
  assert.equal(capText("  padded  ", 50), "padded");
});

test("publicRecord exposes only the right fields per status", () => {
  const done = publicRecord({ id: "b-1", question: "q", status: "done", answer: "a", ms: 1200, createdAt: "t", finishedAt: "t2" });
  assert.deepEqual(done, { id: "b-1", question: "q", status: "done", createdAt: "t", answer: "a", ms: 1200 });
  const running = publicRecord({ id: "b-2", question: "q", status: "running", createdAt: "t", answer: "leak?" });
  assert.deepEqual(running, { id: "b-2", question: "q", status: "running", createdAt: "t" });
  const failed = publicRecord({ id: "b-3", question: "q", status: "failed", createdAt: "t" });
  assert.equal(failed.error, "Claude couldn't answer.");
  assert.equal(publicRecord(null), null);
});
