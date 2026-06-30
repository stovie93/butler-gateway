import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, serializeMemory, parseMemory, matchId, extractCaptureFact, extractPassiveFact } from "./index.js";

test("extractPassiveFact captures high-confidence durable facts", () => {
  assert.equal(extractPassiveFact("oh by the way I'm allergic to peanuts"), "Jordan is allergic to peanuts.");
  assert.equal(extractPassiveFact("heads up — I am allergic to shellfish"), "Jordan is allergic to shellfish.");
  assert.equal(extractPassiveFact("I'm working at Pixar now"), "Jordan works at Pixar.");
  assert.equal(extractPassiveFact("my dog is named Rex and he's huge"), "Jordan's dog is named Rex.");
  assert.equal(extractPassiveFact("my wife's name is Sarah"), "Jordan's wife is named Sarah.");
  assert.equal(extractPassiveFact("I live in Denver"), "Jordan lives in Denver.");
  assert.equal(extractPassiveFact("I work at Lockheed Martin these days"), "Jordan works at Lockheed Martin.");
  assert.equal(extractPassiveFact("my favourite team is Arsenal"), "Jordan's favourite team is Arsenal.");
});

test("extractPassiveFact rejects generic/pronoun objects and questions (precision)", () => {
  assert.equal(extractPassiveFact("where do I live again?"), null); // question
  assert.equal(extractPassiveFact("I work for myself"), null); // pronoun object
  assert.equal(extractPassiveFact("I live in a van down by the river"), null); // article object
  assert.equal(extractPassiveFact("I work at home"), null); // filler object
  assert.equal(extractPassiveFact("my favourite thing is you"), null); // pronoun object
  assert.equal(extractPassiveFact("I'm from there originally"), null); // filler object
  assert.equal(extractPassiveFact("build me a snake game"), null); // unrelated
  assert.equal(extractPassiveFact("how are you today?"), null);
});

test("extractCaptureFact catches explicit remember intents", () => {
  assert.equal(extractCaptureFact("Please remember that my cat is named Pixel."), "My cat is named Pixel.");
  assert.equal(extractCaptureFact("remember my anniversary is June 5"), "My anniversary is June 5");
  assert.equal(extractCaptureFact("note that I work night shifts"), "I work night shifts");
  assert.equal(extractCaptureFact("don't forget I'm allergic to peanuts"), "I'm allergic to peanuts");
  assert.equal(extractCaptureFact("keep in mind I prefer dark mode"), "I prefer dark mode");
});

test("extractCaptureFact ignores recall questions and non-triggers", () => {
  assert.equal(extractCaptureFact("do you remember my cat's name?"), null);
  assert.equal(extractCaptureFact("what do you remember about me?"), null);
  assert.equal(extractCaptureFact("my cat is named Pixel"), null); // no trigger word
  assert.equal(extractCaptureFact(""), null);
});

test("extractCaptureFact skips timed reminders and todos", () => {
  assert.equal(extractCaptureFact("remember to call mum in 2 hours"), null);
  assert.equal(extractCaptureFact("remind me at 6pm to take out the bins"), null);
  assert.equal(extractCaptureFact("don't forget to buy milk"), null); // imperative todo
  assert.equal(extractCaptureFact("remember the meeting is tomorrow"), null); // timed
});

test("newId is sortable and chronological", () => {
  const a = newId();
  const b = newId();
  assert.match(a, /^\d{8}-\d{9}-[a-z0-9]{4}$/);
  // Same-millisecond ids differ by the random suffix; lexicographic order holds
  // for ids generated later (timestamp prefix dominates).
  assert.ok(a <= b || a.slice(0, 17) === b.slice(0, 17));
});

test("serializeMemory → parseMemory round-trips", () => {
  const record = {
    id: "20260629-100000000-ab12",
    created: "2026-06-29T16:00:00.000Z",
    source: "jordan",
    tags: ["work", "preference"],
    text: "Jordan prefers concise replies.",
  };
  const md = serializeMemory(record);
  const back = parseMemory(md);
  assert.deepEqual(back, record);
});

test("serializeMemory writes clean frontmatter + prose body", () => {
  const md = serializeMemory({
    id: "x1",
    created: "2026-06-29T16:00:00.000Z",
    source: "butler",
    tags: [],
    text: "The dog's name is Rex.",
  });
  assert.match(md, /^---\nid: x1\n/);
  assert.match(md, /\ntags: \[\]\n/);
  assert.match(md, /\n---\n\nThe dog's name is Rex\.\n$/);
});

test("parseMemory tolerates CRLF and missing tags", () => {
  const md = "---\r\nid: y2\r\ncreated: 2026-06-29T16:00:00.000Z\r\nsource: butler\r\n---\r\nA fact.\r\n";
  const back = parseMemory(md);
  assert.equal(back.id, "y2");
  assert.equal(back.source, "butler");
  assert.deepEqual(back.tags, []);
  assert.equal(back.text, "A fact.");
});

test("parseMemory rejects non-memory text", () => {
  assert.equal(parseMemory("just some notes\nno frontmatter"), null);
  assert.equal(parseMemory("---\nnoid: true\n---\nbody"), null);
  assert.equal(parseMemory(""), null);
});

test("matchId resolves exact ids and unique prefixes", () => {
  const mems = [
    { id: "20260629-100000000-aaaa", text: "one" },
    { id: "20260629-110000000-bbbb", text: "two" },
  ];
  assert.equal(matchId(mems, "20260629-100000000-aaaa").record.text, "one");
  assert.equal(matchId(mems, "20260629-11").record.text, "two");
  assert.ok(matchId(mems, "20260629-1").error.includes("Ambiguous"));
  assert.ok(matchId(mems, "zzz").error.includes("No matching"));
  assert.ok(matchId(mems, "").error.includes("Need a memory id"));
});
