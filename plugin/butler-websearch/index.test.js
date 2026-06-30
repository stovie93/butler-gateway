import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSearchQuery, buildSearchContext } from "./index.js";

test("extractSearchQuery fires on explicit search intent and strips lead-ins", () => {
  assert.equal(extractSearchQuery("search for the best ramen in Tokyo"), "the best ramen in Tokyo");
  assert.equal(extractSearchQuery("Hey Clawdia, can you google the iphone 17 release date?"), "the iphone 17 release date");
  assert.equal(extractSearchQuery("look up who won the 2026 super bowl"), "who won the 2026 super bowl");
  assert.equal(extractSearchQuery("what's the weather in Denver today?"), "what's the weather in Denver today");
});

test("extractSearchQuery catches a pasted URL", () => {
  assert.equal(extractSearchQuery("can you summarize https://example.com/article"), "summarize https://example.com/article");
});

test("extractSearchQuery ignores ordinary messages", () => {
  assert.equal(extractSearchQuery("how are you today?"), null);
  assert.equal(extractSearchQuery("remember that my cat is named Pixel"), null);
  assert.equal(extractSearchQuery("build me a snake game"), null);
  assert.equal(extractSearchQuery(""), null);
});

test("buildSearchContext renders answer + sources, or null when empty", () => {
  assert.equal(buildSearchContext("q", { answer: "", results: [] }), null);
  assert.equal(buildSearchContext("q", null), null);
  const out = buildSearchContext("iphone 17 release", {
    answer: "The iPhone 17 launched on 19 September 2026.",
    results: [{ title: "Apple Newsroom", url: "https://apple.com/x", content: "Apple announced the iPhone 17..." }],
  });
  assert.match(out, /Live web results/);
  assert.match(out, /Quick answer: The iPhone 17 launched/);
  assert.match(out, /1\. Apple Newsroom — Apple announced/);
  assert.match(out, /source of truth/);
});
