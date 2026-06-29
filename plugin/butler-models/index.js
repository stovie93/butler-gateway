import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler models: lists the chat models the butler can use, so the app can offer
// a model picker. Switching is done client-side per request via the
// `x-openclaw-model` header (no restart) — this endpoint is just the catalog.

const CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");

function readJson(file) {
  try {
    let t = readFileSync(file, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Strip a leading provider prefix ("ollama/gpt-oss:20b" → "gpt-oss:20b") so the
// id matches both the config model ids and the bare `x-openclaw-model` value.
function bareId(modelRef) {
  const s = String(modelRef ?? "");
  const i = s.indexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

// Read the configured ollama chat models + the current default. Pure-ish
// (exported for tests); takes the parsed config so tests don't touch disk.
function listModels(cfg) {
  const root = cfg ?? {};
  const primary = root?.agents?.defaults?.model?.primary ?? "";
  const entries = root?.models?.providers?.ollama?.models;
  const models = Array.isArray(entries)
    ? entries
        .map((m) => (m && typeof m.id === "string" ? m.id : null))
        .filter(Boolean)
        .map((id) => ({ id, label: id, cloud: /:cloud$/.test(id) }))
    : [];
  return { default: bareId(primary), models };
}

export { bareId, listModels };

export default {
  id: "butler-models",
  name: "Butler Models",
  description: "Lists the chat models the butler can use, for the app's model picker.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    api.registerHttpRoute({
      path: "/api/v1/chat-models",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        res.statusCode = (req.method ?? "GET").toUpperCase() === "GET" ? 200 : 405;
        res.setHeader("Content-Type", "application/json");
        if (res.statusCode === 405) {
          res.setHeader("Allow", "GET");
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return true;
        }
        res.end(JSON.stringify(listModels(readJson(CONFIG_FILE))));
        return true;
      },
    });
  },
};
