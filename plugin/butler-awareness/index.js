import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler awareness: gives the local model situational awareness on EVERY turn,
// instead of relying on it to call tools (which a weak 20B model does
// unreliably). On each `before_prompt_build` we synthesize a compact context
// block and prepend it to the system prompt:
//
//   • the clock         — current local date/time (she has no clock otherwise,
//                          so she can't reason about "tonight" / reminder timing)
//   • live state        — running build jobs + pending reminders (so she knows
//                          what's happening on Jordan's PC without asking)
//   • auto-recall       — top semantic memory hits for Jordan's latest message,
//                          so she actually *knows him* every turn with no
//                          dependence on her calling the `recall` tool
//
// All of this is plain text generation the model latches well — the same
// "harness acts, model talks" pattern as the build marker and persona inject.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const REMINDERS_DIR = join(WORKSPACE, "reminders");
const JOBS_DIR = join(WORKSPACE, "jobs");

const AGENT = "main";

// Only auto-recall for substantive messages — skip "ok", "thanks", "hi".
const MIN_RECALL_LEN = 8;
// Hard ceiling on the memory lookup so a slow/cold index never stalls a reply.
const RECALL_TIMEOUT_MS = 3500;
// Cache recall by query so retries / quick re-sends don't re-shell every time.
const RECALL_CACHE_MS = 90_000;
const _recallCache = new Map(); // normQuery -> { at, snippets }

// ---- helpers ---------------------------------------------------------------

function readJson(file) {
  try {
    let t = readFileSync(file, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// Only act on genuine interactive user turns — not the gateway's internal
// boot-check / heartbeat / subagent prompt builds (which also report
// trigger="user" but carry no message provider/channel). Avoids spending a
// memory-search subprocess on every internal model call. Mirrors OpenClaw's
// active-memory gating.
function isInteractive(ctx) {
  if (!ctx || ctx.trigger !== "user") return false;
  if (!ctx.sessionKey && !ctx.sessionId) return false;
  if ((ctx.messageProvider ?? "").trim().toLowerCase() === "webchat") return true;
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Manual format (no ICU locale dependence): "Tuesday, 30 June 2026, 3:47 PM".
function formatNow(d = new Date()) {
  let h = d.getHours();
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12;
  if (h === 0) h = 12;
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${h}:${min} ${ap}`;
}

// Short relative label for a future epoch-ms ("in 2h 10m", "in 5m", "now").
function relativeLabel(fireAt, now = Date.now()) {
  let diff = Math.round((fireAt - now) / 1000);
  if (diff <= 0) return "now";
  const days = Math.floor(diff / 86400); diff -= days * 86400;
  const hrs = Math.floor(diff / 3600); diff -= hrs * 3600;
  const mins = Math.floor(diff / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hrs) parts.push(`${hrs}h`);
  if (mins && !days) parts.push(`${mins}m`);
  if (!parts.length) parts.push("<1m");
  return "in " + parts.join(" ");
}

// Pending reminders, soonest first (cheap local file reads).
function pendingReminders() {
  if (!existsSync(REMINDERS_DIR)) return [];
  return readdirSync(REMINDERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(REMINDERS_DIR, f)))
    .filter((r) => r && r.status === "pending" && typeof r.fireAt === "number")
    .sort((a, b) => a.fireAt - b.fireAt);
}

// Currently-running build jobs (cheap local file reads).
function runningJobs() {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(JOBS_DIR, f)))
    .filter((m) => m && m.status === "running")
    .map((m) => ({ project: m.project ? String(m.project).split(/[\\/]/).pop() : "?", task: m.task ?? "" }));
}

// ---- memory recall (CLI vector search, same bridge butler-memory uses) ------

function cliEntry() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const entry = join(appdata, "npm", "node_modules", "openclaw", "openclaw.mjs");
  return existsSync(entry) ? entry : null;
}

// Run `openclaw memory search` and return [{snippet, score}]; [] on any failure.
// shell:false with an args array → memory text can't break out into the shell.
function searchMemories(query, max = 3) {
  return new Promise((resolve) => {
    const entry = cliEntry();
    const cmd = entry ? process.execPath : "openclaw";
    const base = ["memory", "search", query, "--agent", AGENT, "--max-results", String(max), "--json"];
    const full = entry ? [entry, ...base] : base;
    let out = "";
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };
    let ps;
    try {
      ps = spawn(cmd, full, { windowsHide: true, shell: !entry });
    } catch {
      return done([]);
    }
    ps.stdout?.on("data", (d) => (out += d.toString()));
    ps.on("error", () => done([]));
    ps.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim());
        const results = Array.isArray(parsed?.results) ? parsed.results : [];
        done(
          results
            .map((r) => String(r?.snippet ?? "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .map((s) => (s.length > 200 ? s.slice(0, 200) + "…" : s)),
        );
      } catch {
        done([]);
      }
    });
    const t = setTimeout(() => { try { ps.kill(); } catch {} done([]); }, RECALL_TIMEOUT_MS);
    if (t.unref) t.unref();
  });
}

// Text of a user message, tolerating string or parts-array content shapes.
function userText(m) {
  if (!m || m.role !== "user") return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (typeof p === "string" ? p : String(p?.text ?? ""))).join(" ");
  }
  return "";
}

// Build the recall query. Follow-ups are usually short ("what about the other
// one?") and carry no searchable meaning on their own — for those we fold in
// the last couple of user turns from the session. A substantive message stands
// on its own so old topics don't dilute the search. Pure + unit-tested.
export function recallQuery(prompt, messages) {
  const current = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (current.length < MIN_RECALL_LEN) return "";
  if (current.length >= 60) return current;
  const prior = (Array.isArray(messages) ? messages : [])
    .map(userText)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t && t !== current)
    .slice(-2)
    .map((t) => (t.length > 150 ? t.slice(0, 150) : t));
  return [...prior, current].join("\n");
}

// Cached recall: returns [] fast for short messages and on cache hits.
async function recallFor(prompt) {
  const q = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (q.length < MIN_RECALL_LEN) return [];
  const key = q.toLowerCase().slice(0, 200);
  const hit = _recallCache.get(key);
  if (hit && Date.now() - hit.at < RECALL_CACHE_MS) return hit.snippets;
  const snippets = await searchMemories(q, 3);
  _recallCache.set(key, { at: Date.now(), snippets });
  // Keep the cache from growing unbounded.
  if (_recallCache.size > 100) {
    for (const k of _recallCache.keys()) { _recallCache.delete(k); if (_recallCache.size <= 80) break; }
  }
  return snippets;
}

// ---- context assembly (pure, unit-testable) --------------------------------

function buildAwareness({ now = new Date(), reminders = [], jobs = [], memories = [] } = {}) {
  const lines = ["# Right now", `The current local date & time is ${formatNow(now)}.`];

  const state = [];
  if (jobs.length) {
    state.push(jobs.length === 1
      ? `A build is running: ${jobs[0].project}.`
      : `${jobs.length} builds are running (${jobs.map((j) => j.project).slice(0, 3).join(", ")}).`);
  }
  if (reminders.length) {
    const next = reminders[0];
    state.push(`${reminders.length} reminder${reminders.length === 1 ? "" : "s"} pending; next: "${String(next.text).slice(0, 60)}" ${relativeLabel(next.fireAt, now.getTime())}.`);
  }
  if (state.length) lines.push("", "# On Jordan's PC", ...state.map((s) => `- ${s}`));

  if (memories.length) {
    lines.push(
      "",
      "# What you know about Jordan (auto-recalled for his latest message)",
      ...memories.map((m) => `- ${m}`),
      "Weave anything relevant in naturally, as something you simply know. Don't recite this list " +
        "back unless he asks what you remember, and never mention memory files, sources, or that this " +
        "was \"recalled\" — just know it.",
    );
  }
  return lines.join("\n");
}

export { buildAwareness, formatNow, relativeLabel };

export default {
  id: "butler-awareness",
  name: "Butler Awareness",
  description:
    "Gives the model situational awareness every turn — the clock, running builds, pending reminders, and auto-recalled memories — without relying on tool calls.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    if (typeof api.on !== "function") return;

    api.on("before_prompt_build", async (event, ctx) => {
      try {
        if (!isInteractive(ctx)) return;
        // Clock + live state are instant local reads; never let them throw.
        let reminders = [];
        let jobs = [];
        try { reminders = pendingReminders(); } catch {}
        try { jobs = runningJobs(); } catch {}

        // Auto-recall is best-effort and time-boxed; on miss we still ship the
        // clock + state, so a slow index can never stall or blank the reply.
        let memories = [];
        try { memories = await recallFor(recallQuery(event?.prompt, event?.messages)); } catch {}

        return { prependSystemContext: buildAwareness({ now: new Date(), reminders, jobs, memories }) };
      } catch {
        return; // never break prompt assembly
      }
    });
  },
};
