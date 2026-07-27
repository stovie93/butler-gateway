import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatClaudeStream,
  parseDurationMs,
  parseBuildArgs,
  briefInput,
  humanSize,
  progressFrom,
  fallbackReport,
  resultFrom,
} from "./index.js";

test("formatClaudeStream renders a stream-json timeline", () => {
  const log = [
    JSON.stringify({ type: "system", subtype: "init", model: "claude-x" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] } }),
    JSON.stringify({ type: "result", duration_ms: 2000, total_cost_usd: 0.05, is_error: false, result: "all done" }),
  ].join("\n");

  const out = formatClaudeStream(log);
  assert.match(out, /▶ session started · claude-x/);
  assert.match(out, /💬 hi there/);
  assert.match(out, /🔧 Bash · ls -la/);
  assert.match(out, /✓ done · 2s · \$0\.05/);
  assert.match(out, /all done/);
});

test("formatClaudeStream marks errors", () => {
  const log = JSON.stringify({ type: "result", is_error: true, duration_ms: 1000 });
  assert.match(formatClaudeStream(log), /✗ error · 1s/);
});

test("formatClaudeStream passes through plain (non-event) logs", () => {
  const plain = "just an old plain-text log\nno json here";
  assert.equal(formatClaudeStream(plain), plain);
});

test("parseDurationMs handles units, combos, bare minutes, and junk", () => {
  assert.equal(parseDurationMs("2h"), 2 * 3600_000);
  assert.equal(parseDurationMs("90m"), 90 * 60_000);
  assert.equal(parseDurationMs("1h30m"), 90 * 60_000);
  assert.equal(parseDurationMs("45s"), 45_000);
  assert.equal(parseDurationMs("10"), 10 * 60_000); // bare number = minutes
  assert.equal(parseDurationMs(""), null);
  assert.equal(parseDurationMs("garbage"), null);
});

test("parseBuildArgs splits project/task and strips --continue", () => {
  assert.deepEqual(parseBuildArgs("myproj do the thing"), {
    project: "myproj",
    task: "do the thing",
    continueSession: false,
  });
  assert.deepEqual(parseBuildArgs("myproj --continue do the thing"), {
    project: "myproj",
    task: "do the thing",
    continueSession: true,
  });
  assert.deepEqual(parseBuildArgs("--continue myproj do thing"), {
    project: "myproj",
    task: "do thing",
    continueSession: true,
  });
  assert.equal(parseBuildArgs("justoneword"), null);
  assert.equal(parseBuildArgs(""), null);
});

test("briefInput picks a field, truncates, and tolerates junk", () => {
  assert.equal(briefInput({ command: "ls -la" }), "ls -la");
  assert.equal(briefInput({ file_path: "/a/b" }), "/a/b");
  assert.equal(briefInput(null), "");
  assert.equal(briefInput({}), "");

  const long = "x".repeat(100);
  const out = briefInput({ command: long });
  assert.equal(out.length, 81); // 80 chars + ellipsis
  assert.ok(out.endsWith("…"));
});

test("progressFrom digests the latest tool call from a live log", () => {
  const log = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }),
  ].join("\n");
  assert.deepEqual(progressFrom(log), { tools: 2, last: "Bash · npm test" });
});

test("progressFrom survives a half-written trailing line", () => {
  const log =
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } }) +
    '\n{"type":"assis';
  assert.deepEqual(progressFrom(log), { tools: 1, last: "Edit" });
});

test("progressFrom on an empty log reports nothing in flight", () => {
  assert.deepEqual(progressFrom(""), { tools: 0, last: "" });
});

test("humanSize switches units at a megabyte", () => {
  assert.equal(humanSize(52_428_800), "50.0 MB");
  assert.equal(humanSize(4096), "4 KB");
  assert.equal(humanSize(undefined), "");
});

test("fallbackReport leads with the APK when a build produced one", () => {
  const out = fallbackReport(
    { project: "C:\\repos\\butler-app", status: "done", result: { summary: "Shipped the widget." } },
    { type: "apk", name: "butler-v0.24.0.apk", size: 52_428_800 },
    ["app.json"],
  );
  assert.match(out, /^Build finished: butler-app\./);
  assert.match(out, /Shipped the widget\./);
  assert.match(out, /APK ready to install: butler-v0\.24\.0\.apk \(50\.0 MB\)/);
});

test("resultFrom takes the last result event and keeps non-ASCII intact", () => {
  const log = [
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    JSON.stringify({ type: "result", duration_ms: 1, is_error: true, result: "first" }),
    JSON.stringify({ type: "result", duration_ms: 535004, total_cost_usd: 2.36, is_error: false, result: "Built it — arrows → intact." }),
  ].join("\n");
  assert.deepEqual(resultFrom(log), {
    durationMs: 535004,
    costUsd: 2.36,
    isError: false,
    summary: "Built it — arrows → intact.",
  });
});

test("resultFrom reads pretty-printed result lines, not just compact ones", () => {
  const spaced = '{"type": "result", "duration_ms": 4200, "result": "spaced out"}';
  assert.equal(resultFrom(spaced)?.summary, "spaced out");
  assert.equal(resultFrom(spaced)?.durationMs, 4200);
});

test("resultFrom ignores non-result lines that merely mention result", () => {
  const log = [
    '{"type":"assistant","message":{"content":[{"type":"text","text":"the result is good"}]}}',
    '{"type":"result","result":"actual"}',
  ].join("\n");
  assert.equal(resultFrom(log).summary, "actual");
});

test("resultFrom truncates a long summary and returns null with no result event", () => {
  const long = JSON.stringify({ type: "result", result: "y".repeat(600) });
  const out = resultFrom(long);
  assert.equal(out.summary.length, 501);
  assert.ok(out.summary.endsWith("…"));
  assert.equal(resultFrom('{"type":"assistant"}'), null);
  assert.equal(resultFrom(""), null);
});

test("fallbackReport falls back to a changed-file count and flags failure", () => {
  const out = fallbackReport({ project: "/r/calendar-sync", status: "failed" }, null, ["a.ts", "b.ts"]);
  assert.match(out, /^Build failed: calendar-sync\./);
  assert.match(out, /2 files changed\./);
});
