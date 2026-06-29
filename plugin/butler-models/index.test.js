import { test } from "node:test";
import assert from "node:assert/strict";
import { bareId, listModels } from "./index.js";

test("bareId strips the provider prefix", () => {
  assert.equal(bareId("ollama/gpt-oss:20b"), "gpt-oss:20b");
  assert.equal(bareId("gpt-oss:20b"), "gpt-oss:20b");
  assert.equal(bareId(""), "");
});

test("listModels returns the default + flagged model list", () => {
  const cfg = {
    agents: { defaults: { model: { primary: "ollama/gpt-oss:20b" } } },
    models: {
      providers: {
        ollama: {
          models: [
            { id: "gpt-oss:20b" },
            { id: "qwen3:14b" },
            { id: "glm-5:cloud" },
          ],
        },
      },
    },
  };
  const out = listModels(cfg);
  assert.equal(out.default, "gpt-oss:20b");
  assert.equal(out.models.length, 3);
  assert.deepEqual(out.models[0], { id: "gpt-oss:20b", label: "gpt-oss:20b", cloud: false });
  assert.equal(out.models.find((m) => m.id === "glm-5:cloud").cloud, true);
});

test("listModels is safe on an empty/missing config", () => {
  const out = listModels(null);
  assert.equal(out.default, "");
  assert.deepEqual(out.models, []);
});
