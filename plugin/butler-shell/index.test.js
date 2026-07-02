import { test } from "node:test";
import assert from "node:assert/strict";
import { capAppend, formatResult, validateCommand } from "./index.js";

test("validateCommand trims, rejects empty and oversized", () => {
  assert.deepEqual(validateCommand("  Get-Date  "), { ok: true, command: "Get-Date" });
  assert.equal(validateCommand("").ok, false);
  assert.equal(validateCommand("   ").ok, false);
  assert.equal(validateCommand(null).ok, false);
  assert.equal(validateCommand("x".repeat(5000)).ok, false);
  // CRLF normalised so the approval card and audit log stay single-flavoured.
  assert.deepEqual(validateCommand("echo a\r\necho b"), { ok: true, command: "echo a\necho b" });
});

test("capAppend caps output exactly once", () => {
  assert.equal(capAppend("", "hello", 100), "hello");
  const capped = capAppend("aaaa", "b".repeat(200), 10);
  assert.ok(capped.startsWith("aaaabbbbbb"));
  assert.ok(capped.includes("(output truncated)"));
  // Already at cap: further chunks are ignored, no double marker.
  assert.equal(capAppend(capped, "more", 10), capped);
});

test("formatResult renders success, stderr, timeout, and spawn failure", () => {
  assert.equal(
    formatResult({ exitCode: 0, stdout: "42\n", stderr: "", timedOut: false }),
    "Exit code 0.\n\n42",
  );
  const withErr = formatResult({ exitCode: 1, stdout: "", stderr: "boom", timedOut: false });
  assert.ok(withErr.includes("Exit code 1."));
  assert.ok(withErr.includes("[stderr]\nboom"));
  const silent = formatResult({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  assert.ok(silent.includes("(no output)"));
  const timedOut = formatResult({ exitCode: null, stdout: "partial", stderr: "", timedOut: true, timeoutMs: 90000 });
  assert.ok(timedOut.includes("Timed out after 90s"));
  assert.ok(timedOut.includes("partial"));
  assert.equal(formatResult({ error: "ENOENT" }), "⚠ Failed to run: ENOENT");
});
