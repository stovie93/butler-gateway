import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhen, toRfc3339, buildJwtClaims, pluginConfigFrom, matchEvents, describeEvent } from "./index.js";

// A fixed "now": Monday 27 July 2026, 14:30 local.
const NOW = new Date(2026, 6, 27, 14, 30, 0);

test("parseWhen trusts a timestamp that carries its own offset", () => {
  assert.equal(parseWhen("2026-08-07T14:00:00Z", NOW), Date.parse("2026-08-07T14:00:00Z"));
  assert.equal(parseWhen("2026-08-07T14:00:00-06:00", NOW), Date.parse("2026-08-07T14:00:00-06:00"));
});

test("parseWhen reads an offset-less timestamp as local time", () => {
  // The owner lives in the host's zone; 14:00 means 14:00 to them.
  const got = new Date(parseWhen("2026-08-07T14:00:00", NOW));
  assert.equal(got.getHours(), 14);
  assert.equal(got.getDate(), 7);
  assert.equal(got.getMonth(), 7);
});

test("parseWhen handles relative offsets", () => {
  assert.equal(parseWhen("in 30 minutes", NOW), NOW.getTime() + 30 * 60_000);
  assert.equal(parseWhen("in 2 hours", NOW), NOW.getTime() + 2 * 3_600_000);
  assert.equal(parseWhen("in 1 day", NOW), NOW.getTime() + 86_400_000);
});

test("parseWhen resolves tomorrow and today with a clock time", () => {
  const tomorrow = new Date(parseWhen("tomorrow at 3pm", NOW));
  assert.equal(tomorrow.getDate(), 28);
  assert.equal(tomorrow.getHours(), 15);
  assert.equal(tomorrow.getMinutes(), 0);

  const today = new Date(parseWhen("today at 9:15am", NOW));
  assert.equal(today.getDate(), 27);
  assert.equal(today.getHours(), 9);
  assert.equal(today.getMinutes(), 15);
});

test("parseWhen reads 'tonight at 8' as the evening", () => {
  // The trap: a bare 8 with no meridiem would otherwise book 08:00.
  const t = new Date(parseWhen("tonight at 8", NOW));
  assert.equal(t.getHours(), 20);
  assert.equal(t.getDate(), 27);
});

test("parseWhen picks the *next* named weekday", () => {
  // NOW is a Monday; "friday" is this coming Friday the 31st.
  const fri = new Date(parseWhen("friday at 9am", NOW));
  assert.equal(fri.getDay(), 5);
  assert.equal(fri.getDate(), 31);
  assert.equal(fri.getHours(), 9);

  // Asking for the same weekday means a week out, not today.
  const mon = new Date(parseWhen("monday at 10am", NOW));
  assert.equal(mon.getDate(), 3); // 3 August
});

test("parseWhen gives up rather than guessing", () => {
  // Booking at the wrong time is worse than asking, so these must be undefined.
  assert.equal(parseWhen("sometime next week", NOW), undefined);
  assert.equal(parseWhen("soon", NOW), undefined);
  assert.equal(parseWhen("tomorrow", NOW), undefined); // a day with no time
  assert.equal(parseWhen("", NOW), undefined);
  assert.equal(parseWhen(undefined, NOW), undefined);
});

test("toRfc3339 emits a local offset, not UTC", () => {
  const s = toRfc3339(new Date(2026, 7, 7, 14, 0, 0).getTime());
  assert.match(s, /^2026-08-07T14:00:00[+-]\d{2}:\d{2}$/);
  // Round-trips to the same instant.
  assert.equal(Date.parse(s), new Date(2026, 7, 7, 14, 0, 0).getTime());
});

test("buildJwtClaims requests calendar scope for the service account", () => {
  const c = buildJwtClaims("sa@project.iam.gserviceaccount.com", 1_700_000_000);
  assert.equal(c.iss, "sa@project.iam.gserviceaccount.com");
  assert.equal(c.scope, "https://www.googleapis.com/auth/calendar");
  assert.equal(c.aud, "https://oauth2.googleapis.com/token");
  assert.equal(c.exp - c.iat, 3600);
});

test("pluginConfigFrom reads our entry out of the gateway config", () => {
  // The bug this guards: register() receives only the api, so a plugin that
  // expects config as a second argument silently gets {} — and calendarId then
  // defaults to "primary", which for a service account is its own hidden calendar.
  const root = {
    plugins: { entries: { "butler-calendar": { config: { calendarId: "me@example.com" } } } },
  };
  assert.equal(pluginConfigFrom(root).calendarId, "me@example.com");
  assert.deepEqual(pluginConfigFrom({}), {});
  assert.deepEqual(pluginConfigFrom(undefined), {});
  assert.deepEqual(pluginConfigFrom({ plugins: { entries: {} } }), {});
});

const ev = (summary, dateTime) => ({ id: summary, summary, start: { dateTime } });

test("matchEvents finds an event by its exact title", () => {
  const items = [ev("Lunch with Sam", "2026-07-28T12:30:00-06:00"), ev("Dentist", "2026-07-29T14:00:00-06:00")];
  const got = matchEvents(items, "Lunch with Sam");
  assert.equal(got.length, 1);
  assert.equal(got[0].summary, "Lunch with Sam");
});

test("matchEvents is case-insensitive and matches on a fragment", () => {
  const items = [ev("Lunch with Sam", "2026-07-28T12:30:00-06:00")];
  assert.equal(matchEvents(items, "lunch")[0]?.summary, "Lunch with Sam");
  assert.equal(matchEvents(items, "LUNCH WITH SAM")[0]?.summary, "Lunch with Sam");
});

test("matchEvents prefers an exact title over looser matches", () => {
  // "Standup" must not drag in "Standup prep" when the owner named it exactly.
  const items = [ev("Standup", "2026-07-28T09:00:00-06:00"), ev("Standup prep", "2026-07-28T08:30:00-06:00")];
  const got = matchEvents(items, "Standup");
  assert.equal(got.length, 1);
  assert.equal(got[0].summary, "Standup");
});

test("matchEvents returns every candidate when genuinely ambiguous", () => {
  // The caller refuses to delete on more than one; it must not silently pick.
  const items = [ev("Team meeting", "2026-07-28T09:00:00-06:00"), ev("Client meeting", "2026-07-28T11:00:00-06:00")];
  assert.equal(matchEvents(items, "meeting").length, 2);
});

test("matchEvents matches on significant words in any order", () => {
  const items = [ev("Sam / lunch catch-up", "2026-07-28T12:30:00-06:00")];
  assert.equal(matchEvents(items, "lunch with Sam").length, 1);
});

test("matchEvents finds nothing rather than guessing", () => {
  const items = [ev("Dentist", "2026-07-29T14:00:00-06:00")];
  assert.deepEqual(matchEvents(items, "haircut"), []);
  assert.deepEqual(matchEvents(items, ""), []);
  assert.deepEqual(matchEvents([], "anything"), []);
  // Stop-words alone must not match everything.
  assert.deepEqual(matchEvents(items, "the my"), []);
});

test("describeEvent reads back title and time", () => {
  const s = describeEvent(ev("Lunch with Sam", "2026-07-28T12:30:00-06:00"));
  assert.match(s, /Lunch with Sam/);
  assert.match(s, /12:30/);
});
