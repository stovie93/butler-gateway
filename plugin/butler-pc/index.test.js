import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePcArgs, resolveOpenTarget, resolveVolume, ACTION_NAMES, OPEN_TARGETS } from "./index.js";

test("parsePcArgs splits action and arg, lowercasing the action", () => {
  assert.deepEqual(parsePcArgs("disk"), { action: "disk", arg: "" });
  assert.deepEqual(parsePcArgs("OPEN spotify"), { action: "open", arg: "spotify" });
  assert.deepEqual(parsePcArgs("  volume   up  "), { action: "volume", arg: "up" });
  assert.deepEqual(parsePcArgs("open my cool app"), { action: "open", arg: "my cool app" });
  assert.deepEqual(parsePcArgs(""), { action: "", arg: "" });
  assert.deepEqual(parsePcArgs(null), { action: "", arg: "" });
});

test("resolveOpenTarget only allows allow-listed apps", () => {
  assert.equal(resolveOpenTarget("spotify"), "spotify:");
  assert.equal(resolveOpenTarget("Spotify"), "spotify:"); // case-insensitive
  assert.equal(resolveOpenTarget("browser"), "msedge");
  assert.equal(resolveOpenTarget("code"), "code");
  assert.equal(resolveOpenTarget("rm -rf"), null); // arbitrary input rejected
  assert.equal(resolveOpenTarget(""), null);
  assert.equal(resolveOpenTarget(undefined), null);
});

test("resolveVolume normalises directions and synonyms", () => {
  assert.equal(resolveVolume("up"), "up");
  assert.equal(resolveVolume("louder"), "up");
  assert.equal(resolveVolume("DOWN"), "down");
  assert.equal(resolveVolume("-"), "down");
  assert.equal(resolveVolume("mute"), "mute");
  assert.equal(resolveVolume("sideways"), null);
  assert.equal(resolveVolume(""), null);
});

test("ACTION_NAMES are unique and the open allow-list is non-empty", () => {
  assert.equal(new Set(ACTION_NAMES).size, ACTION_NAMES.length);
  assert.ok(ACTION_NAMES.includes("status"));
  assert.ok(ACTION_NAMES.includes("lock"));
  assert.ok(Object.keys(OPEN_TARGETS).length > 0);
});
