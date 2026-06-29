import { test } from "node:test";
import assert from "node:assert/strict";
import { newId, serializeMemory, parseMemory, matchId } from "./index.js";

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
