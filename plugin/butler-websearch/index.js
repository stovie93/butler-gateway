import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler web search: gives the local model LIVE web info without depending on
// it to call a search tool (the agent's "coding" tool-profile strips
// tavily_search anyway, and a weak model wouldn't reliably call it). Instead,
// on each turn we detect an explicit "look this up" intent in Jordan's message,
// call the Tavily REST API directly (server-side, using the key already
// configured for the tavily plugin), and inject the results into the prompt —
// the same "harness fetches, model just talks" pattern as auto-recall.
//
// Privacy: it ONLY fires on an explicit search intent (Jordan asked to look
// something up / pasted a URL), so the outbound query is always intentional.

const CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");
// Outbound-search audit: every Tavily call is logged so Jordan can see exactly
// what left the machine (and so we can verify the feature fired). Best-effort.
const AUDIT_FILE = join(homedir(), ".openclaw", "workspace", "websearch-audit.log");

function audit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

const SEARCH_TIMEOUT_MS = 6000;
const SEARCH_CACHE_MS = 300_000; // 5 min — repeated asks don't re-hit the API

// Explicit "go look this up" signals. Kept fairly tight to avoid firing (and
// spending an API call) on ordinary chit-chat.
const SEARCH_TRIGGER =
  /\b(?:search(?:\s+the\s+web)?(?:\s+for)?|google|look\s+up|look\s+it\s+up|web\s+search|what'?s\s+the\s+latest|latest\s+news|news\s+(?:on|about)|current\s+(?:weather|price|news|score|events?)|today'?s\s+(?:weather|news|score)|weather\s+(?:in|for|today|tomorrow|this)|stock\s+price|share\s+price|exchange\s+rate|who\s+won)\b/i;
const URL_RE = /https?:\/\/\S+/i;

function readJson(file) {
  try {
    let t = readFileSync(file, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Only act on genuine interactive user turns — NOT the gateway's internal
// boot-check / heartbeat / subagent prompt builds (which also report
// trigger="user" but carry no message provider/channel). Mirrors OpenClaw's
// own active-memory gating. Critical here so internal prompts never leak to
// Tavily and we don't spend API calls on system self-checks.
function isInteractive(ctx) {
  if (!ctx || ctx.trigger !== "user") return false;
  if (!ctx.sessionKey && !ctx.sessionId) return false;
  if ((ctx.messageProvider ?? "").trim().toLowerCase() === "webchat") return true;
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

// The Tavily key the user already configured for the tavily plugin. Null if
// unset → the whole feature quietly no-ops.
function loadKey() {
  const root = readJson(CONFIG_FILE) ?? {};
  const k = root?.plugins?.entries?.tavily?.config?.webSearch?.apiKey;
  return typeof k === "string" && k.trim() ? k.trim() : null;
}

// Pull a tight search query out of an explicit search-intent message, or null
// if the message isn't a search ask. Pure + unit-tested.
function extractSearchQuery(prompt) {
  const raw = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (!SEARCH_TRIGGER.test(raw) && !URL_RE.test(raw)) return null;

  let q = raw
    .replace(/^(?:hey\s+)?(?:clawdia|butler)[,!:]?\s*/i, "")
    .replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, "")
    .replace(/^please\s+/i, "")
    .replace(
      /^(?:search(?:\s+the\s+web)?(?:\s+for)?|google|look\s+up|look\s+it\s+up|web\s+search(?:\s+for)?|find\s+(?:out\s+)?(?:about\s+)?|what'?s\s+the\s+latest\s+(?:on|about|in|with)?|latest\s+news\s+(?:on|about)?|news\s+(?:on|about))\s*[:,-]?\s*/i,
      "",
    )
    .trim()
    .replace(/[?.!]+$/, "")
    .trim();
  if (q.length < 2) q = raw; // strip ate everything → fall back to the message
  return q.slice(0, 300);
}

// Call Tavily's REST search. Sends the key both as a Bearer header and in the
// body so it works across API versions. Returns { answer, results } or null.
async function tavilySearch(key, query, timeoutMs = SEARCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ api_key: key, query, max_results: 5, include_answer: true, search_depth: "basic" }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    const results = Array.isArray(j?.results)
      ? j.results.slice(0, 4).map((r) => ({
          title: String(r?.title ?? "").trim(),
          url: String(r?.url ?? "").trim(),
          content: String(r?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
        }))
      : [];
    return { answer: typeof j?.answer === "string" ? j.answer.trim() : "", results };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Render fetched results into a compact prompt block. Pure + unit-tested.
function buildSearchContext(query, data) {
  if (!data || (!data.answer && !(data.results && data.results.length))) return null;
  const lines = [`# Live web results (fetched just now for: "${query}")`];
  if (data.answer) lines.push("", `Quick answer: ${data.answer}`);
  if (data.results && data.results.length) {
    lines.push("", "Sources:");
    data.results.forEach((r, i) => lines.push(`${i + 1}. ${r.title} — ${r.content} (${r.url})`));
  }
  lines.push(
    "",
    "Answer Jordan using this current information as the source of truth. Keep it natural and " +
      "concise, and don't dump raw URLs unless he asks for the link.",
  );
  return lines.join("\n");
}

export { extractSearchQuery, buildSearchContext, tavilySearch };

export default {
  id: "butler-websearch",
  name: "Butler Web Search",
  description:
    "Live web answers injected on explicit search intent — calls Tavily server-side and feeds results to the model, no tool-calling needed.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    if (typeof api.on !== "function") return;
    const key = loadKey();
    const cache = new Map(); // query -> { at, block }

    api.on("before_prompt_build", async (event, ctx) => {
      try {
        if (!key || !isInteractive(ctx)) return;
        const q = extractSearchQuery(event?.prompt);
        if (!q) return;

        const ck = q.toLowerCase();
        const hit = cache.get(ck);
        if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) {
          return hit.block ? { prependSystemContext: hit.block } : undefined;
        }

        const data = await tavilySearch(key, q);
        const block = buildSearchContext(q, data);
        audit({ query: q, status: data ? (block ? "ok" : "empty") : "fail", results: data?.results?.length ?? 0 });
        cache.set(ck, { at: Date.now(), block });
        if (cache.size > 50) cache.clear();
        return block ? { prependSystemContext: block } : undefined;
      } catch {
        return; // never break prompt assembly
      }
    });
  },
};
