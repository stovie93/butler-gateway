import { test } from "node:test";
import assert from "node:assert/strict";
import { formatClaudeStream, parseDurationMs, parseBuildArgs, briefInput } from "./index.js";

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
