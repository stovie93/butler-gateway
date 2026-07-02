import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPageContext,
  buildSearchContext,
  extractSearchQuery,
  extractUrl,
  htmlToText,
  isBlockedHost,
} from "./index.js";

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

test("extractUrl pulls the first link and strips trailing punctuation", () => {
  assert.equal(extractUrl("read https://example.com/article please"), "https://example.com/article");
  assert.equal(extractUrl("what do you think of https://a.io/x?id=1)."), "https://a.io/x?id=1");
  assert.equal(extractUrl("no links here"), null);
  assert.equal(extractUrl(""), null);
});

test("isBlockedHost refuses loopback/private/link-local targets", () => {
  assert.equal(isBlockedHost("http://localhost:18789/api"), true);
  assert.equal(isBlockedHost("http://127.0.0.1/x"), true);
  assert.equal(isBlockedHost("http://10.1.2.3/"), true);
  assert.equal(isBlockedHost("http://172.20.0.1/"), true);
  assert.equal(isBlockedHost("http://192.168.1.1/admin"), true);
  assert.equal(isBlockedHost("http://169.254.1.1/"), true);
  assert.equal(isBlockedHost("http://router.local/"), true);
  assert.equal(isBlockedHost("not a url"), true);
  assert.equal(isBlockedHost("https://example.com/"), false);
  assert.equal(isBlockedHost("https://172.15.0.1/"), false); // outside 172.16/12
});

test("htmlToText strips scripts/tags and decodes entities", () => {
  const html =
    "<html><head><title>T</title><style>p{color:red}</style></head><body>" +
    "<script>evil()</script><h1>Hello &amp; welcome</h1><p>Line one</p><p>Line&nbsp;two</p></body></html>";
  const text = htmlToText(html);
  assert.ok(!text.includes("evil"));
  assert.ok(!text.includes("color:red"));
  assert.match(text, /Hello & welcome/);
  assert.match(text, /Line one\nLine two/);
});

test("buildPageContext renders title + text, or null when empty", () => {
  assert.equal(buildPageContext("https://x.com", null), null);
  assert.equal(buildPageContext("https://x.com", { title: "t", text: "" }), null);
  const out = buildPageContext("https://example.com", { title: "Example Domain", text: "Some body text." });
  assert.match(out, /fetched just now from https:\/\/example\.com/);
  assert.match(out, /Title: Example Domain/);
  assert.match(out, /Some body text\./);
  assert.match(out, /source of truth/);
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
