import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePersona, renderIdentity, renderSoulBlock, upsertSoulBlock, DEFAULT_PERSONA, FIELDS } from "./index.js";

test("mergePersona overlays only known string fields", () => {
  const merged = mergePersona(DEFAULT_PERSONA, { name: "Pip", vibe: "calm", junk: "x", emoji: 5 });
  assert.equal(merged.name, "Pip");
  assert.equal(merged.vibe, "calm");
  assert.equal(merged.emoji, DEFAULT_PERSONA.emoji); // non-string ignored
  assert.equal(merged.junk, undefined); // unknown field dropped
  assert.equal(merged.personality, DEFAULT_PERSONA.personality); // untouched
});

test("mergePersona with empty patch returns the base", () => {
  assert.deepEqual(mergePersona(DEFAULT_PERSONA, {}), DEFAULT_PERSONA);
});

test("default persona is Clawdia and exposes the editable fields", () => {
  assert.equal(DEFAULT_PERSONA.name, "Clawdia");
  for (const f of ["name", "creature", "vibe", "emoji", "personality"]) {
    assert.ok(FIELDS.includes(f));
  }
});

test("renderIdentity produces injectable IDENTITY.md with the persona", () => {
  const md = renderIdentity({
    name: "Clawdia",
    creature: "AI butler",
    vibe: "bubbly & playful",
    emoji: "🫧",
    personality: "Upbeat and helpful.",
    signature: "",
  });
  assert.match(md, /^# IDENTITY\.md/);
  assert.match(md, /\*\*Name:\*\* Clawdia/);
  assert.match(md, /\*\*Vibe:\*\* bubbly & playful/);
  assert.match(md, /## Personality\n\nUpbeat and helpful\./);
  assert.doesNotMatch(md, /Sign-off/); // empty signature omitted
});

test("renderIdentity includes a sign-off only when set", () => {
  const md = renderIdentity({ ...DEFAULT_PERSONA, signature: "— C" });
  assert.match(md, /\*\*Sign-off:\*\* — C/);
});

test("renderSoulBlock forces the name + identity", () => {
  const block = renderSoulBlock(DEFAULT_PERSONA);
  assert.match(block, /# You are Clawdia/);
  assert.match(block, /Always introduce yourself and identify as Clawdia/);
  assert.match(block, /Never say you are "Claude"/);
});

test("owner name flows through when set and falls back generically when not", () => {
  assert.ok(FIELDS.includes("owner"));
  const merged = mergePersona(DEFAULT_PERSONA, { owner: "Jordan" });
  assert.equal(merged.owner, "Jordan");
  assert.match(renderSoulBlock(merged), /Jordan's personal AI butler/);
  assert.match(renderSoulBlock(DEFAULT_PERSONA), /your human's personal AI butler/);
  assert.match(renderIdentity(merged), /\*\*Your human:\*\* Jordan/);
  assert.doesNotMatch(renderIdentity(DEFAULT_PERSONA), /Your human/);
});

test("upsertSoulBlock prepends a block, preserving existing content", () => {
  const soul = "# SOUL.md\n\nCore truths here.\n";
  const out = upsertSoulBlock(soul, renderSoulBlock(DEFAULT_PERSONA));
  assert.match(out, /^<!-- BUTLER-PERSONA:START/);
  assert.match(out, /Core truths here\./); // original kept
});

test("upsertSoulBlock replaces an existing managed block (no duplication)", () => {
  const soul = "# SOUL.md\n\nCore truths here.\n";
  const once = upsertSoulBlock(soul, renderSoulBlock(DEFAULT_PERSONA));
  const twice = upsertSoulBlock(once, renderSoulBlock({ ...DEFAULT_PERSONA, name: "Pip" }));
  assert.equal((twice.match(/BUTLER-PERSONA:START/g) || []).length, 1); // exactly one block
  assert.match(twice, /# You are Pip/);
  assert.doesNotMatch(twice, /# You are Clawdia/);
  assert.match(twice, /Core truths here\./);
});
