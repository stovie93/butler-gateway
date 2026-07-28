import { test } from "node:test";
import assert from "node:assert/strict";
import {
  globToRegExp,
  isSensitive,
  isValidDecision,
  decisionToStatus,
  argsBrief,
  buildJwtClaims,
  isDestructiveCommand,
  extractCommand,
  needsCommandApproval,
} from "./index.js";

test("globToRegExp matches literals, *, and ?", () => {
  assert.ok(globToRegExp("trade_stock").test("trade_stock"));
  assert.ok(!globToRegExp("trade_stock").test("trade_stocks"));
  assert.ok(globToRegExp("trade_*").test("trade_anything"));
  assert.ok(globToRegExp("buy_?").test("buy_x"));
  assert.ok(!globToRegExp("buy_?").test("buy_xy"));
  // glob metachars don't leak regex meaning
  assert.ok(!globToRegExp("a.b").test("axb"));
  assert.ok(globToRegExp("a.b").test("a.b"));
});

test("isSensitive matches against the policy list", () => {
  const policy = ["trade_*", "wire_money"];
  assert.ok(isSensitive("trade_stock", policy));
  assert.ok(isSensitive("wire_money", policy));
  assert.ok(!isSensitive("search_jobs", policy));
  assert.ok(!isSensitive("trade_stock", [])); // empty policy gates nothing
  assert.ok(!isSensitive("", policy));
  assert.ok(!isSensitive("x", undefined));
});

test("isValidDecision accepts only allow-once / deny", () => {
  assert.ok(isValidDecision("allow-once"));
  assert.ok(isValidDecision("deny"));
  assert.ok(!isValidDecision("allow-always"));
  assert.ok(!isValidDecision("yes"));
  assert.ok(!isValidDecision(undefined));
});

test("decisionToStatus maps decisions to terminal statuses", () => {
  assert.equal(decisionToStatus("allow-once"), "allowed");
  assert.equal(decisionToStatus("deny"), "denied");
  assert.equal(decisionToStatus("anything-else"), "expired");
});

test("argsBrief picks a field, stringifies, and truncates", () => {
  assert.equal(argsBrief({ summary: "sell 10 AAPL" }), "sell 10 AAPL");
  assert.equal(argsBrief({ command: "rm -rf x" }), "rm -rf x");
  assert.equal(argsBrief(null), "");
  assert.equal(argsBrief({ foo: 1, bar: 2 }), '{"foo":1,"bar":2}'); // no known field → JSON
  const long = "z".repeat(300);
  const out = argsBrief({ summary: long });
  assert.equal(out.length, 201); // 200 + ellipsis
  assert.ok(out.endsWith("…"));
});

test("buildJwtClaims builds the FCM service-account assertion claims", () => {
  const sa = { client_email: "butler@proj.iam.gserviceaccount.com" };
  const claims = buildJwtClaims(sa, 1000);
  assert.equal(claims.iss, "butler@proj.iam.gserviceaccount.com");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp, 1000 + 3600); // 1h lifetime
});

// ---- destructive-command gating -------------------------------------------

test("isDestructiveCommand catches deletes across shells", () => {
  for (const cmd of [
    "rm file.txt",
    "rm -rf build/",
    "rmdir /s /q dist",
    String.raw`del C:\temp\x.txt`,
    "erase notes.md",
    "Remove-Item -Recurse -Force .\dist",
    "remove-item foo",
    "ri foo.txt",
    "unlink /tmp/sock",
    "shred -u secret.key",
  ]) {
    assert.equal(isDestructiveCommand(cmd), true, `should gate: ${cmd}`);
  }
});

test("isDestructiveCommand catches moves and renames", () => {
  for (const cmd of ["mv a b", "move a.txt b.txt", "ren old.txt new.txt", "Move-Item a b", "Rename-Item a b", "rni a b"]) {
    assert.equal(isDestructiveCommand(cmd), true, `should gate: ${cmd}`);
  }
});

test("isDestructiveCommand sees through separators and wrappers", () => {
  // The whole point: hiding it behind a harmless first command must not work.
  assert.equal(isDestructiveCommand("npm test && rm -rf node_modules"), true);
  assert.equal(isDestructiveCommand("echo hi; del important.txt"), true);
  assert.equal(isDestructiveCommand("ls | rm -rf ."), true);
  assert.equal(isDestructiveCommand("sudo rm -rf /var/log"), true);
  assert.equal(isDestructiveCommand("FOO=1 rm bar"), true);
  assert.equal(isDestructiveCommand(String.raw`C:\Windows\System32\del.exe x.txt`), true);
  assert.equal(isDestructiveCommand("git rm --cached secrets.env"), true);
  assert.equal(isDestructiveCommand("git mv old new"), true);
  assert.equal(isDestructiveCommand("git clean -fd"), true);
  assert.equal(isDestructiveCommand("node -e \"require('fs').unlinkSync('a')\""), true);
});

test("isDestructiveCommand leaves ordinary commands alone", () => {
  // False positives here would train the owner to tap approve without reading.
  for (const cmd of [
    "npm install",
    "npm run build",
    "git status",
    "git commit -m 'remove old thing'",
    "ls -la",
    "cat removal-notes.txt",
    "echo 'move along'",
    "node scripts/remove-duplicates.js",
    "grep -r 'rm' src/",
    "npm run rm-cache",
    "",
  ]) {
    assert.equal(isDestructiveCommand(cmd), false, `should NOT gate: ${cmd}`);
  }
});

test("extractCommand copes with the shapes tools use", () => {
  assert.equal(extractCommand({ command: "rm x" }), "rm x");
  assert.equal(extractCommand({ cmd: "del x" }), "del x");
  assert.equal(extractCommand({ script: "mv a b" }), "mv a b");
  assert.equal(extractCommand({ args: ["rm", "-rf", "x"] }), "rm -rf x");
  assert.equal(extractCommand({ nothing: 1 }), "");
  assert.equal(extractCommand(null), "");
});

test("needsCommandApproval only fires for shell tools, and honours the switch", () => {
  assert.equal(needsCommandApproval("exec", { command: "rm -rf x" }), true);
  // run_command self-gates inside execute; gating it here as well double-prompts.
  assert.equal(needsCommandApproval("run_command", { command: "del x" }), false);
  assert.equal(needsCommandApproval("bash", { command: "mv a b" }), true);
  // A calendar tool whose text merely contains "rm" must not be gated by this path.
  assert.equal(needsCommandApproval("create_event", { summary: "rm meeting" }), false);
  assert.equal(needsCommandApproval("exec", { command: "npm test" }), false);
  // Config off.
  assert.equal(needsCommandApproval("exec", { command: "rm -rf x" }, false), false);
});
