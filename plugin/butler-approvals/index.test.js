import { test } from "node:test";
import assert from "node:assert/strict";
import { globToRegExp, isSensitive, isValidDecision, decisionToStatus, argsBrief, buildJwtClaims } from "./index.js";

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
