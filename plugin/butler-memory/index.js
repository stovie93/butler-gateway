import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler memory: a curated, durable memory of who Jordan is and what he does.
// Each fact is a small markdown file under the OpenClaw workspace `memory/`
// directory, which is the indexed source for the gateway's vector recall — so a
// remembered fact is automatically surfaced in conversation (and is searchable
// on demand). Both the butler (via the `remember` tool, mid-conversation) and
// Jordan (via the app / `/remember` command) can write memories; everything is
// reviewable and deletable. Three surfaces: the remember/recall/forget agent
// tools, the /remember /recall /forget commands, and an HTTP route for the app.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const MEMORY_DIR = join(WORKSPACE, "memory");
const AUDIT_FILE = join(WORKSPACE, "dispatch-audit.log");
const CONFIG_FILE = join(HOME, ".openclaw", "openclaw.json");

// Our curated memories live alongside the auto-captured session files in the
// indexed memory dir, distinguished by this filename prefix so list/forget only
// ever touch memories the butler owns (never the session summaries or seeds).
const PREFIX = "butler-";
const AGENT = "main";

// Config captured at register() time.
let _cfg = { reindexOnWrite: true };

// ---- store helpers ---------------------------------------------------------

function readText(file) {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
    return text;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    const text = readText(file);
    return text == null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function memPath(id) {
  return join(MEMORY_DIR, `${PREFIX}${id}.md`);
}

function appendAudit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

function loadConfig() {
  const root = readJson(CONFIG_FILE) ?? {};
  const c = root?.plugins?.entries?.["butler-memory"]?.config ?? {};
  return {
    // Reindex the vector store after a write so the new fact is recallable in
    // chat right away. Default on; turn off to batch reindexing manually.
    reindexOnWrite: c.reindexOnWrite !== false,
  };
}

// Sortable id: yyyymmdd-HHMMSSmmm + random suffix (lexicographic == chronological).
function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---- pure (de)serialization (unit-tested) ----------------------------------

// Render a memory record as a markdown file: a small frontmatter block (so the
// app can read structure back) followed by the fact as plain prose (so the
// vector index embeds clean, human text).
function serializeMemory(m) {
  return [
    "---",
    `id: ${m.id}`,
    `created: ${m.created}`,
    `source: ${m.source}`,
    `tags: ${JSON.stringify(Array.isArray(m.tags) ? m.tags : [])}`,
    "---",
    "",
    String(m.text ?? "").trim(),
    "",
  ].join("\n");
}

// Parse a memory markdown file back into a record, or null if it isn't one of
// ours / is malformed. Tolerant of CRLF and missing optional fields.
function parseMemory(md) {
  const text = String(md ?? "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const f = line.match(/^(\w+):\s*(.*)$/);
    if (f) fields[f[1]] = f[2];
  }
  if (!fields.id) return null;
  let tags = [];
  if (fields.tags) {
    try {
      const parsed = JSON.parse(fields.tags);
      if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
    } catch {}
  }
  return {
    id: fields.id,
    created: fields.created || "",
    source: fields.source || "butler",
    tags,
    text: m[2].trim(),
  };
}

// Match a memory by exact id or a unique id prefix. Returns
// { record } | { error } so callers can give a precise message.
function matchId(memories, key) {
  const k = String(key ?? "").trim();
  if (!k) return { error: "Need a memory id." };
  const matches = memories.filter((r) => r.id === k || r.id.startsWith(k));
  if (matches.length === 0) return { error: "No matching memory." };
  if (matches.length > 1) return { error: `Ambiguous — ${matches.length} memories match "${k}".` };
  return { record: matches[0] };
}

// ---- guaranteed capture (deterministic, harness-side) ----------------------

// A weak local model frequently FAILS to call the `remember` tool even when
// Jordan explicitly asks it to ("remember that my cat is Pixel"). So we also
// catch the obvious "save this" intents deterministically in the prompt hook
// and guarantee the write — the same "harness acts, model just talks" pattern
// the rest of the butler leans on. Conservative on purpose: only fires on an
// explicit trigger, skips questions, and skips timed/imperative items (those
// are reminders or todos, not durable facts).
const CAPTURE_TRIGGER = /\b(remember|note this|note that|make a note|don'?t forget|keep in mind|for (?:future|the) (?:reference|record))\b/i;
const QUESTION_LEAD = /^\s*(?:do|does|did|can|could|will|would|what|what'?s|whats|who|when|where|why|how)\b/i;
const TIMED_HINT = /\b(?:at \d|in \d+\s*(?:s|sec|secs|min|mins|minute|minutes|hour|hours|hr|hrs|day|days|week|weeks)|tomorrow|tonight|today|this (?:morning|afternoon|evening)|o'?clock|\d\s*(?:am|pm))\b/i;

// Pull a durable fact out of an explicit "remember …" message, or null if the
// message isn't a clear capture intent. Pure + unit-tested.
function extractCaptureFact(prompt) {
  const raw = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!raw || !CAPTURE_TRIGGER.test(raw)) return null;
  // "do you remember my cat's name?" is recall, not capture.
  if (raw.includes("?") || QUESTION_LEAD.test(raw)) return null;

  let t = raw.replace(/^please\s+/i, "");
  // Strip the leading intent phrase but NOT a trailing "to" — leaving it lets
  // the imperative-todo guard below catch "remember TO call mum".
  t = t.replace(/^(?:remember|note this|note that|make a note|keep in mind)(?:\s+(?:that|this))?\s*[:,-]?\s*/i, "");
  t = t.replace(/^don'?t forget(?:\s+that)?\s*[:,-]?\s*/i, "");
  t = t.replace(/^for (?:future|the) (?:reference|record)\s*[:,-]?\s*/i, "");
  t = t.trim();
  if (t.length < 3 || t.length > 400) return null;
  if (TIMED_HINT.test(t)) return null; // a reminder, handled elsewhere
  if (/^to\s+\w/i.test(t)) return null; // "remember to call mum" → a todo
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---- passive capture (durable facts mentioned in passing) ------------------

// Beyond explicit "remember…" intents, pick up high-confidence durable facts
// Jordan states in passing ("I'm allergic to peanuts", "my dog is named Rex")
// so memory compounds on its own. Deliberately HIGH-PRECISION: a curated set of
// first-person patterns, each guarded against generic/pronoun objects, because
// a wrong "remembered" fact is worse than a missed one. Saved tagged "auto" so
// it's easy to review/delete in the app.
const STOP_OBJECTS = /^(?:a|an|the|my|your|his|her|their|our|this|that|these|those|it|its|i|you|he|she|we|they|me|him|them|us|myself|yourself|himself|herself|themselves|ourselves|here|there|home|work|school|bed|some|any|no|not|sure|good|great|fine|ok|okay|nothing|something|anything|everyone|someone|going|doing|trying|just|really|very|so|too|now|today|tonight|tomorrow)\b/i;

function cleanObj(s) {
  return String(s ?? "").trim().replace(/^["'(]+/, "").replace(/["').,!?;:]+$/g, "").replace(/\s+/g, " ").trim();
}

// Validate a captured object is a real, specific value (not a pronoun/article
// or filler). Returns the cleaned object or null.
function objOrNull(s) {
  let c = cleanObj(s);
  // Drop trailing temporal filler so "Lockheed Martin these days" → "Lockheed Martin".
  c = c.replace(/\s+(?:these days|nowadays|now|currently|at the moment|right now|at present|atm|today|lately|recently)\b.*$/i, "").trim();
  if (c.length < 2 || c.length > 60) return null;
  if (STOP_OBJECTS.test(c)) return null;
  return c;
}

const PASSIVE_PATTERNS = [
  { re: /\b(?:i'?m|i am) allergic to (.+?)(?:[.,!?]|$)/i, f: (m) => { const o = objOrNull(m[1]); return o && `Jordan is allergic to ${o}.`; } },
  {
    re: /\bmy (wife|husband|partner|girlfriend|boyfriend|fianc[ée]+|son|daughter|kid|child|baby|dog|cat|pet|boss|manager|mum|mom|dad|father|mother|brother|sister|roommate|flatmate)(?:'?s)?(?: name)? (?:is|are) (?:named |called )?([A-Za-z][\w'’-]{1,28})/i,
    f: (m) => {
      const name = cleanObj(m[2]);
      if (!name) return null;
      // Without an explicit "named/called", require a capitalized name so
      // "my dog is huge" / "my boss is great" don't become false facts.
      const explicit = /\b(?:named|called)\s/i.test(m[0]);
      if (!explicit && !/^[A-Z]/.test(name)) return null;
      return `Jordan's ${m[1].toLowerCase()} is named ${name}.`;
    },
  },
  { re: /\bmy birthday(?:'s| is)(?: on)? (.+?)(?:[.,!?]|$)/i, f: (m) => { const o = objOrNull(m[1]); return o && `Jordan's birthday is ${o}.`; } },
  { re: /\b(?:i live|i'?m living|i am living) in (.+?)(?:[.,!?]|$)/i, f: (m) => { const o = objOrNull(m[1]); return o && `Jordan lives in ${o}.`; } },
  { re: /\b(?:i'?m|i am) from (.+?)(?:[.,!?]|$)/i, f: (m) => { const o = objOrNull(m[1]); return o && `Jordan is from ${o}.`; } },
  { re: /\b(?:i work|i'?m working|i am working) (?:at|for) (.+?)(?:[.,!?]|$)/i, f: (m) => { const o = objOrNull(m[1]); return o && `Jordan works at ${o}.`; } },
  { re: /\b(?:i work|i'?m working|i am working) as (?:an? )?(.+?)(?:[.,!?]|$)/i, f: (m) => { const o = objOrNull(m[1]); return o && `Jordan works as ${o}.`; } },
  { re: /\bmy favou?rite (.+?) is (.+?)(?:[.,!?]|$)/i, f: (m) => { const a = objOrNull(m[1]), b = objOrNull(m[2]); return a && b && `Jordan's favourite ${a} is ${b}.`; } },
];

// Pull a single high-confidence durable fact out of a passing statement, or
// null. Skips questions outright. Pure + unit-tested.
function extractPassiveFact(prompt) {
  const raw = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.includes("?")) return null;
  for (const { re, f } of PASSIVE_PATTERNS) {
    const m = raw.match(re);
    if (m) {
      const fact = f(m);
      if (fact && fact.length >= 8 && fact.length <= 200) return fact;
    }
  }
  return null;
}

// ---- CLI bridge (reindex + semantic search) --------------------------------

// Resolve the OpenClaw CLI's JS entry so we can run it via `node` directly
// (shell:false, args array → no shell-escaping/injection from memory text).
function cliEntry() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const entry = join(appdata, "npm", "node_modules", "openclaw", "openclaw.mjs");
  return existsSync(entry) ? entry : null;
}

// Run an openclaw CLI subcommand, capturing stdout. Resolves { stdout, code }
// (never rejects). Used for memory search; killed after timeoutMs.
function runCli(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const entry = cliEntry();
    const cmd = entry ? process.execPath : "openclaw";
    const full = entry ? [entry, ...args] : args;
    let out = "";
    let done = false;
    const finish = (code) => {
      if (!done) {
        done = true;
        resolve({ stdout: out, code });
      }
    };
    let ps;
    try {
      ps = spawn(cmd, full, { windowsHide: true, shell: !entry });
    } catch {
      return finish(-1);
    }
    ps.stdout?.on("data", (d) => (out += d.toString()));
    ps.on("error", () => finish(-1));
    ps.on("close", (code) => finish(code));
    const t = setTimeout(() => {
      try {
        ps.kill();
      } catch {}
      finish(-2);
    }, timeoutMs);
    if (t.unref) t.unref();
  });
}

// Reindex the vector store so a just-written/removed memory is recallable.
// Fire-and-forget; never throws. No-op when reindexOnWrite is off.
function reindex() {
  if (!_cfg.reindexOnWrite) return;
  const entry = cliEntry();
  try {
    const cmd = entry ? process.execPath : "openclaw";
    const args = entry
      ? [entry, "memory", "index", "--agent", AGENT]
      : ["memory", "index", "--agent", AGENT];
    const ps = spawn(cmd, args, { windowsHide: true, stdio: "ignore", shell: !entry });
    ps.on("error", () => {});
    ps.unref();
  } catch {}
}

// ---- store operations ------------------------------------------------------

// All curated butler memories, newest first.
function listMemories() {
  if (!existsSync(MEMORY_DIR)) return [];
  return readdirSync(MEMORY_DIR)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".md"))
    .map((f) => parseMemory(readText(join(MEMORY_DIR, f))))
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// Save a fact. source is "butler" (the agent remembered it) or "jordan" (he
// asked / added it in the app). Returns { ok, record? , error? }.
function addMemory(text, { tags = [], source = "butler" } = {}) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, error: "What should I remember?" };
  ensureDir();
  const id = newId();
  const record = {
    id,
    text: body.slice(0, 2000),
    tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12) : [],
    source: source === "jordan" ? "jordan" : "butler",
    created: new Date().toISOString(),
  };
  writeFileSync(memPath(id), serializeMemory(record), "utf8");
  appendAudit({ action: "memory.add", id, source: record.source, text: record.text.slice(0, 200) });
  reindex();
  return { ok: true, record };
}

// ---- session journal ---------------------------------------------------------
// When Jordan clears a chat, the app first sends the transcript here. We have
// the local model write a short journal entry and save it as a memory, so the
// next conversation can recall what the last one was about — continuity across
// the session rotation instead of a clean lobotomy.

const JOURNAL_MAX_MESSAGES = 24;
const JOURNAL_MSG_CHARS = 400;
const JOURNAL_MIN_MESSAGES = 4;

// Render a transcript for the summarizer. Pure + unit-tested. Null when the
// conversation is too thin to be worth a journal entry.
export function buildJournalPrompt(messages) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      // The build marker is UI plumbing, not conversation.
      text: m.content.replace(/\[\[BUILD:[\s\S]*?\]\]/gi, " ").replace(/\s+/g, " ").trim(),
    }))
    .filter((m) => m.text);
  if (turns.length < JOURNAL_MIN_MESSAGES) return null;
  const transcript = turns
    .slice(-JOURNAL_MAX_MESSAGES)
    .map((m) => `${m.role === "user" ? "Jordan" : "You"}: ${m.text.slice(0, JOURNAL_MSG_CHARS)}`)
    .join("\n");
  return (
    "Jordan just closed this conversation. Write your private journal entry for it: 2-4 plain " +
    "sentences, past tense, capturing what it was about, anything decided or accomplished, and " +
    "any detail worth knowing in future conversations. No greetings, no markdown, no preamble — " +
    "output only the journal entry itself.\n\n--- conversation ---\n" +
    transcript
  );
}

function memoryGatewayAuth() {
  const root = readJson(CONFIG_FILE) ?? {};
  return { token: root?.gateway?.auth?.token ?? null, port: root?.gateway?.port ?? 18789 };
}

// Ask the local model (fresh loopback session) to write the entry.
async function summarizeTranscript(prompt) {
  const { token, port } = memoryGatewayAuth();
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: "openclaw",
        user: `journal-${Date.now().toString(36)}`,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 800) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function journalConversation(messages) {
  const prompt = buildJournalPrompt(messages);
  if (!prompt) return { ok: true, skipped: true, reason: "conversation too short" };
  const summary = await summarizeTranscript(prompt);
  if (!summary) return { ok: false, error: "summarizer unavailable" };
  // Local date, not UTC — an evening chat must not be journaled as tomorrow.
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const r = addMemory(`Journal ${date}: ${summary}`, { tags: ["journal"], source: "butler" });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, skipped: false, memory: r.record };
}

// Delete a memory by id (or unique prefix). Returns { ok, record?, error? }.
function deleteMemory(idOrPrefix) {
  const { record, error } = matchId(listMemories(), idOrPrefix);
  if (error) return { ok: false, error };
  try {
    rmSync(memPath(record.id), { force: true });
  } catch (err) {
    return { ok: false, error: `Couldn't delete: ${err.message}` };
  }
  appendAudit({ action: "memory.forget", id: record.id });
  reindex();
  return { ok: true, record };
}

// Semantic search across the whole memory index (curated facts + session
// recall). Returns [{ path, score, snippet }]; [] on any failure.
async function searchMemories(query, max = 5) {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const n = Math.min(Math.max(parseInt(max, 10) || 5, 1), 20);
  const { stdout } = await runCli(["memory", "search", q, "--agent", AGENT, "--max-results", String(n), "--json"]);
  try {
    const parsed = JSON.parse(stdout.trim());
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    return results.map((r) => ({
      path: typeof r.path === "string" ? r.path : "",
      score: typeof r.score === "number" ? r.score : null,
      snippet: String(r.snippet ?? "").trim(),
    }));
  } catch {
    return [];
  }
}

// ---- presentation ----------------------------------------------------------

function summarize(record) {
  const tags = record.tags?.length ? `  [${record.tags.join(", ")}]` : "";
  return `• ${record.id.slice(0, 13)} — ${record.text}${tags}`;
}

function formatSearch(results) {
  if (!results.length) return "I don't have anything on that yet.";
  return results
    .map((r) => {
      const snippet = r.snippet.replace(/\s+/g, " ").slice(0, 240);
      return `• ${snippet}`;
    })
    .join("\n");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export { newId, serializeMemory, parseMemory, matchId, extractCaptureFact, extractPassiveFact };

export default {
  id: "butler-memory",
  name: "Butler Memory",
  description: "A curated, durable memory of the user — remembered facts are stored as indexed notes and recalled in conversation.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    _cfg = loadConfig();

    // Guaranteed capture: when Jordan explicitly asks to remember a fact, save
    // it deterministically even if the model never calls the `remember` tool.
    // Runs on every prompt build; the trigger regex short-circuits instantly for
    // ordinary messages, so it's effectively free when there's nothing to catch.
    if (typeof api.on === "function") {
      const captureCache = new Map(); // fact-key -> ts, dedupe across a turn's calls
      // Only on genuine interactive user turns — not internal boot/heartbeat
      // prompt builds (which also report trigger="user" but have no provider/
      // channel), so we never capture "facts" out of the gateway's own prompts.
      const isInteractive = (ctx) => {
        if (!ctx || ctx.trigger !== "user") return false;
        if (!ctx.sessionKey && !ctx.sessionId) return false;
        if ((ctx.messageProvider ?? "").trim().toLowerCase() === "webchat") return true;
        return Boolean(ctx.channelId && ctx.channelId.trim());
      };
      api.on("before_prompt_build", async (event, ctx) => {
        try {
          if (!isInteractive(ctx)) return;
          // Explicit "remember…" wins; otherwise try a high-confidence passing fact.
          const fact = extractCaptureFact(event?.prompt) || extractPassiveFact(event?.prompt);
          if (!fact) return;
          const key = fact.toLowerCase().slice(0, 80);
          const now = Date.now();
          const seen = captureCache.get(key);
          if (seen && now - seen < 120_000) return; // already handled this turn
          captureCache.set(key, now);
          if (captureCache.size > 200) captureCache.clear();
          // Don't duplicate a fact we already hold (the model may also save it).
          const dup = listMemories().some((m) => m.text.toLowerCase().slice(0, 80) === key);
          if (!dup) addMemory(fact, { source: "jordan", tags: ["auto"] });
        } catch {}
        // Side-effect only — never alters the prompt.
      });
    }

    if (typeof api.registerTool === "function") {
      // The butler calls this on its own when Jordan shares something worth
      // keeping ("I work nights", "my dog's name is Rex", a preference, a goal).
      api.registerTool({
        name: "remember",
        description:
          "Save a durable FACT about the user to long-term memory (e.g. a preference, a personal " +
          "detail, an ongoing project, a goal). This is NOT a timed reminder/alarm — for anything " +
          "with a time ('remind me at 6pm', 'in 2 hours') use set_reminder instead. Use remember " +
          "when the user says 'remember that…', 'note that…', or shares a lasting fact about " +
          "themselves. Store one clear fact per call as a short standalone statement.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The fact to remember, as a short standalone statement." },
            tags: { type: "array", items: { type: "string" }, description: "Optional topic tags, e.g. ['work','preference']." },
          },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const r = addMemory(params?.text, { tags: params?.tags, source: "butler" });
          return { content: [{ type: "text", text: r.ok ? `Got it — I'll remember that. (${r.record.id.slice(0, 13)})` : r.error }] };
        },
      });

      api.registerTool({
        name: "recall",
        description:
          "Search your memory of the user for facts relevant to a query. Use this when you need to " +
          "remember something about the user to answer well — preferences, past context, ongoing work.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look up, e.g. 'work schedule' or 'pets'." },
          },
          required: ["query"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const results = await searchMemories(params?.query, 5);
          return { content: [{ type: "text", text: formatSearch(results) }] };
        },
      });

      api.registerTool({
        name: "forget",
        description: "Delete a remembered fact by its id (an id prefix is fine). Use when the user asks you to forget something.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The memory id (or a unique prefix)." } },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const r = deleteMemory(params?.id);
          return { content: [{ type: "text", text: r.ok ? `Forgotten: "${r.record.text.slice(0, 80)}".` : r.error }] };
        },
      });
    }

    // HTTP control surface for the Butler app's Memory screen (gateway auth).
    // POST /api/v1/memory
    //   {action:"list"}                 → { memories: [...] }
    //   {action:"add", text, tags?}     → { ok, memory }      (source: jordan)
    //   {action:"search", query, max?}  → { results: [...] }
    //   {action:"delete", id}           → { ok }
    api.registerHttpRoute({
      path: "/api/v1/memory",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
          return true;
        };
        if ((req.method ?? "GET").toUpperCase() !== "POST") {
          res.setHeader("Allow", "POST");
          return send(405, { error: "Method Not Allowed" });
        }
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(400, { error: "Invalid JSON body" });
        }
        if (body.action === "list") {
          return send(200, { memories: listMemories() });
        }
        if (body.action === "add") {
          const r = addMemory(body.text, { tags: body.tags, source: "jordan" });
          if (!r.ok) return send(400, { error: r.error });
          return send(200, { ok: true, memory: r.record });
        }
        if (body.action === "search") {
          const results = await searchMemories(body.query, body.max ?? 5);
          return send(200, { results });
        }
        if (body.action === "delete") {
          const r = deleteMemory(body.id);
          if (!r.ok) return send(400, { error: r.error });
          return send(200, { ok: true, memory: r.record });
        }
        if (body.action === "journal") {
          const r = await journalConversation(body.messages);
          return send(r.ok ? 200 : 500, r);
        }
        return send(400, { error: "Unknown action" });
      },
    });

    // Typed chat commands (WhatsApp / chat). Jordan-sourced memories.
    api.registerCommand({
      name: "remember",
      description: "Remember a fact: /remember <fact> (e.g. /remember I prefer concise replies).",
      acceptsArgs: true,
      handler: async (ctx) => {
        const r = addMemory(String(ctx.args ?? ""), { source: "jordan" });
        return { text: r.ok ? `Remembered. (${r.record.id.slice(0, 13)})` : r.error };
      },
    });

    api.registerCommand({
      name: "recall",
      description: "Search your memory: /recall <query>. With no query, lists recent memories.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const q = String(ctx.args ?? "").trim();
        if (!q) {
          const mems = listMemories().slice(0, 15);
          return { text: mems.length ? "Memories:\n" + mems.map(summarize).join("\n") : "No memories yet." };
        }
        const results = await searchMemories(q, 5);
        return { text: formatSearch(results) };
      },
    });

    api.registerCommand({
      name: "forget",
      description: "Forget a memory by id: /forget <id> (an id prefix is fine; use /recall to see ids).",
      acceptsArgs: true,
      handler: async (ctx) => {
        const r = deleteMemory(String(ctx.args ?? ""));
        return { text: r.ok ? `Forgotten: "${r.record.text.slice(0, 80)}".` : r.error };
      },
    });
  },
};
