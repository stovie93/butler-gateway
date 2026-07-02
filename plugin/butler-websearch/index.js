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
const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_HTML = 500_000; // raw bytes we're willing to parse
const FETCH_MAX_CHARS = 6000; // extracted text handed to the model

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

// ---- direct page fetch (paste a link → she reads the actual page) ----------

// First http(s) URL in the message, with trailing punctuation stripped (so
// "read https://x.com/a." doesn't fetch ".../a."). Pure + unit-tested.
function extractUrl(prompt) {
  const m = String(prompt ?? "").match(URL_RE);
  if (!m) return null;
  return m[0].replace(/[)\]}>.,;:!?'"]+$/, "");
}

// Never fetch loopback/private/link-local targets. This gateway is meant to be
// run by anyone on their own machine — a pasted link must not be able to poke
// the local network (e.g. the gateway's own API or a router admin page).
function isBlockedHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (host === "localhost" || host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".localdomain")) return true;
  if (host === "::1" || host === "[::1]") return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

// Crude-but-effective HTML → readable text: drop non-content blocks, turn
// structural tags into line breaks, strip the rest, decode common entities.
function htmlToText(html) {
  let t = String(html ?? "");
  t = t.replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, "\n");
  t = t.replace(/<(br|hr)\s*\/?>/gi, "\n");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 31 && c < 65536 ? String.fromCharCode(c) : " ";
    });
  return t
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

// GET the page and extract title + readable text. Null on anything odd —
// non-HTML/text content, oversized bodies, timeouts, blocked hosts.
async function fetchPage(url, timeoutMs = FETCH_TIMEOUT_MS) {
  if (isBlockedHost(url)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ButlerGateway/1.0)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/text\/|application\/(xhtml|json|xml)/.test(type)) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > 4 * FETCH_MAX_HTML) return null;
    const raw = (await res.text()).slice(0, FETCH_MAX_HTML);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
    const text = (type.includes("html") ? htmlToText(raw) : raw).slice(0, FETCH_MAX_CHARS).trim();
    if (!text) return null;
    return { title, text };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Render a fetched page into a compact prompt block. Pure + unit-tested.
function buildPageContext(url, page) {
  if (!page || !page.text) return null;
  const lines = [`# Page content (fetched just now from ${url})`];
  if (page.title) lines.push("", `Title: ${page.title}`);
  lines.push("", page.text);
  lines.push(
    "",
    "Jordan shared this link — answer using the page content above as the source of truth. " +
      "If he asked something specific about it, answer that; otherwise give him the gist.",
  );
  return lines.join("\n");
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

export { buildPageContext, buildSearchContext, extractSearchQuery, extractUrl, htmlToText, isBlockedHost, tavilySearch };

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
        if (!isInteractive(ctx)) return;

        // A pasted link means "read THIS page" — fetch it directly rather than
        // searching about it. Falls through to search if the fetch fails.
        const url = extractUrl(event?.prompt);
        if (url) {
          const fk = `fetch:${url}`;
          const hit = cache.get(fk);
          if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) {
            if (hit.block) return { prependSystemContext: hit.block };
          } else {
            const page = await fetchPage(url);
            const block = buildPageContext(url, page);
            audit({ url, status: block ? "fetch-ok" : "fetch-fail", chars: page?.text?.length ?? 0 });
            cache.set(fk, { at: Date.now(), block });
            if (cache.size > 50) cache.clear();
            if (block) return { prependSystemContext: block };
          }
        }

        if (!key) return;
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
