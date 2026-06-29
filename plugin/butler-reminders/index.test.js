import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhen, parseClock, nextOccurrence, extractReminder, relativeLabel, buildJwtClaims } from "./index.js";

// Fixed reference point: Mon 2026-06-29 10:00:00 local.
const NOW = new Date(2026, 5, 29, 10, 0, 0, 0).getTime();

test("parseClock reads 12h and 24h clocks, rejects nonsense", () => {
  assert.deepEqual(parseClock("6pm"), { h: 18, min: 0 });
  assert.deepEqual(parseClock("6:30pm"), { h: 18, min: 30 });
  assert.deepEqual(parseClock("9am"), { h: 9, min: 0 });
  assert.deepEqual(parseClock("12am"), { h: 0, min: 0 });
  assert.deepEqual(parseClock("12pm"), { h: 12, min: 0 });
  assert.deepEqual(parseClock("18:00"), { h: 18, min: 0 });
  assert.deepEqual(parseClock("14"), { h: 14, min: 0 });
  assert.equal(parseClock("25"), null);
  assert.equal(parseClock("6:99pm"), null);
  assert.equal(parseClock("later"), null);
  assert.equal(parseClock(""), null);
});

test("parseWhen handles relative durations", () => {
  assert.equal(parseWhen("in 2 hours", NOW), NOW + 2 * 3_600_000);
  assert.equal(parseWhen("in 30 minutes", NOW), NOW + 30 * 60_000);
  assert.equal(parseWhen("in 1 day", NOW), NOW + 86_400_000);
  assert.equal(parseWhen("5m", NOW), NOW + 5 * 60_000);
  assert.equal(parseWhen("2h", NOW), NOW + 2 * 3_600_000);
  assert.equal(parseWhen("in 3 bananas", NOW), null);
});

test("parseWhen resolves clock times to the next occurrence", () => {
  // 6pm today is still ahead of 10am NOW
  assert.equal(parseWhen("at 6pm", NOW), new Date(2026, 5, 29, 18, 0, 0, 0).getTime());
  assert.equal(parseWhen("6pm", NOW), new Date(2026, 5, 29, 18, 0, 0, 0).getTime());
  // 9am already passed today → rolls to tomorrow
  assert.equal(parseWhen("at 9am", NOW), new Date(2026, 5, 30, 9, 0, 0, 0).getTime());
});

test("parseWhen handles tomorrow/today", () => {
  assert.equal(parseWhen("tomorrow", NOW), new Date(2026, 5, 30, 9, 0, 0, 0).getTime());
  assert.equal(parseWhen("tomorrow at 7am", NOW), new Date(2026, 5, 30, 7, 0, 0, 0).getTime());
  assert.equal(parseWhen("today at 5pm", NOW), new Date(2026, 5, 29, 17, 0, 0, 0).getTime());
  assert.equal(parseWhen("", NOW), null);
  assert.equal(parseWhen("whenever", NOW), null);
});

test("nextOccurrence rolls to tomorrow when the time already passed", () => {
  assert.equal(nextOccurrence(NOW, { h: 18, min: 0 }), new Date(2026, 5, 29, 18, 0, 0, 0).getTime());
  assert.equal(nextOccurrence(NOW, { h: 9, min: 0 }), new Date(2026, 5, 30, 9, 0, 0, 0).getTime());
});

test("extractReminder prefers an explicit pipe", () => {
  assert.deepEqual(extractReminder("in 2 hours | call mum"), { when: "in 2 hours", text: "call mum" });
  assert.deepEqual(extractReminder("at 6pm | take the bins out"), { when: "at 6pm", text: "take the bins out" });
});

test("extractReminder sniffs a time phrase out of a sentence", () => {
  assert.deepEqual(extractReminder("call mum in 2 hours"), { when: "in 2 hours", text: "call mum" });
  assert.deepEqual(extractReminder("me to call mum at 6pm"), { when: "at 6pm", text: "call mum" });
  assert.deepEqual(extractReminder("water the plants tomorrow at 9am"), { when: "tomorrow at 9am", text: "water the plants" });
  assert.deepEqual(extractReminder("just text"), { when: "", text: "just text" });
});

test("buildJwtClaims builds the FCM service-account assertion", () => {
  const claims = buildJwtClaims({ client_email: "svc@proj.iam.gserviceaccount.com" }, 1_000_000);
  assert.equal(claims.iss, "svc@proj.iam.gserviceaccount.com");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(claims.iat, 1_000_000);
  assert.equal(claims.exp, 1_000_000 + 3600);
});

test("relativeLabel produces a short human label", () => {
  assert.equal(relativeLabel(NOW + 5 * 60_000, NOW), "in 5m");
  assert.equal(relativeLabel(NOW + 2 * 3_600_000 + 10 * 60_000, NOW), "in 2h 10m");
  assert.equal(relativeLabel(NOW + 86_400_000, NOW), "in 1d");
  assert.equal(relativeLabel(NOW - 1000, NOW), "now");
});
