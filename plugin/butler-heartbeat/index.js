import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler heartbeat: the butler wakes up on a schedule, looks at the world (the
// awareness inject gives every turn the clock, PC state, and memories), and
// decides whether the owner should hear about it. Two pieces:
//
//  1. Scheduled beats — config entries fire an agent turn over the gateway's
//     own /v1 chat endpoint (loopback, fresh session per beat). The reply is
//     pushed to the phone; in "decide" mode the model can stay silent by
//     answering HEARTBEAT_OK. Same harness-acts pattern as the other plugins:
//     the schedule and delivery are deterministic, only the words are the model's.
//  2. notify_owner tool — an unprompted voice. Any turn (heartbeat or normal
//     chat) can push a message to the phone when something matters now.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const HB_DIR = join(WORKSPACE, "heartbeat");
const STATE_FILE = join(HB_DIR, "state.json");
const LOG_FILE = join(HB_DIR, "heartbeat.log");
const CONFIG_FILE = join(HOME, ".openclaw", "openclaw.json");

// Sweep cadence. Beats are minute-granular, so 30s keeps firing prompt without
// burning cycles; overdue "at" beats catch up within their window after a nap.
const SWEEP_MS = 30_000;
// How stale an "at" beat may fire after its scheduled time (PC asleep at 8am,
// awake at 9 → the morning beat still fires; awake at 3pm → skipped).
const CATCHUP_MS = 3 * 3_600_000;
// A local turn can be slow; give the model plenty of rope before giving up.
const TURN_TIMEOUT_MS = 240_000;
const MAX_PUSH_CHARS = 1000;

let sweepTimer = null;
// One beat at a time — beats share the GPU with real chats, don't pile on.
let running = false;

const DEFAULT_ENTRIES = [
  {
    id: "morning-briefing",
    at: "08:00",
    mode: "always",
    title: "☀️ Morning briefing",
    prompt:
      "Good morning! This is your scheduled morning heartbeat — your human hasn't messaged you; " +
      "you're checking in on your own. Using what you can see right now (the time, anything " +
      "running on the PC, pending reminders, what you remember about them), write them a short, " +
      "warm good-morning message for the day ahead: anything due today, anything that finished " +
      "or failed overnight, and one friendly line. Keep it under 80 words, plain text, no markdown.",
  },
];

// The butler's own name + the owner's name, both set in the app's Persona
// editor (persona.json). Used for push titles and the notify tool's wording.
function personaNames() {
  const p = readJson(join(HOME, ".openclaw", "workspace", "persona.json"));
  return {
    butler: (typeof p?.name === "string" && p.name.trim()) || "Butler",
    owner: (typeof p?.owner === "string" && p.owner.trim()) || "",
  };
}

// ---- small io helpers -------------------------------------------------------

function readJson(file) {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function ensureDir() {
  if (!existsSync(HB_DIR)) mkdirSync(HB_DIR, { recursive: true });
}

function readState() {
  return readJson(STATE_FILE) ?? { lastRun: {} };
}

function writeState(state) {
  try {
    ensureDir();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

function log(entry) {
  try {
    ensureDir();
    appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

function gatewayAuth() {
  const cfg = readJson(CONFIG_FILE);
  return { token: cfg?.gateway?.auth?.token ?? null, port: cfg?.gateway?.port ?? 18789 };
}

function loadConfig() {
  const root = readJson(CONFIG_FILE) ?? {};
  const c = root?.plugins?.entries?.["butler-heartbeat"]?.config ?? {};
  const entries = Array.isArray(c.entries) && c.entries.length ? c.entries : DEFAULT_ENTRIES;
  return {
    entries: entries.filter((e) => e && typeof e.id === "string" && typeof e.prompt === "string"),
    quietHours: c.quietHours ?? null, // { start: "22:00", end: "08:00" } — interval beats only
  };
}

// ---- pure scheduling (unit-tested) ------------------------------------------

/** "08:00", "8am", "9:30pm" → { h, min } in 24h, or null. */
export function parseAt(raw) {
  const m = String(raw ?? "").trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return { h, min };
}

/** "2h", "90m", "45 mins", "1 day" → milliseconds, or null. */
export function parseEvery(raw) {
  const m = String(raw ?? "").trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const unit = m[2][0] === "m" ? 60_000 : m[2][0] === "h" ? 3_600_000 : 86_400_000;
  return n * unit;
}

/** True when `now` falls inside quiet hours (handles wrap past midnight). */
export function inQuietHours(now, quiet) {
  if (!quiet) return false;
  const start = parseAt(quiet.start);
  const end = parseAt(quiet.end);
  if (!start || !end) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const s = start.h * 60 + start.min;
  const e = end.h * 60 + end.min;
  if (s === e) return false;
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

/**
 * Decide whether an entry is due. `at` entries fire once per day at their
 * local time (with a catch-up window for a sleeping PC); `every` entries fire
 * on an interval, outside quiet hours. Returns false for malformed entries.
 */
export function isDue(entry, lastRunMs, now, quiet, catchupMs = CATCHUP_MS) {
  if (entry.enabled === false) return false;
  if (entry.at) {
    const t = parseAt(entry.at);
    if (!t) return false;
    const sched = new Date(now);
    sched.setHours(t.h, t.min, 0, 0);
    const schedMs = sched.getTime();
    return now.getTime() >= schedMs && now.getTime() - schedMs <= catchupMs && (lastRunMs ?? 0) < schedMs;
  }
  if (entry.every) {
    const interval = parseEvery(entry.every);
    if (!interval) return false;
    if (inQuietHours(now, quiet)) return false;
    return now.getTime() - (lastRunMs ?? 0) >= interval;
  }
  return false;
}

/**
 * Decide whether a beat's reply goes to the phone. "always" delivers any
 * non-empty reply; "decide" lets the model stay silent with HEARTBEAT_OK.
 */
export function shouldDeliver(reply, mode) {
  const text = String(reply ?? "").trim();
  if (!text) return { deliver: false, body: "" };
  if ((mode ?? "decide") === "decide" && /\bHEARTBEAT_OK\b/i.test(text)) return { deliver: false, body: "" };
  return { deliver: true, body: text.length > MAX_PUSH_CHARS ? text.slice(0, MAX_PUSH_CHARS - 1) + "…" : text };
}

// ---- the beat ----------------------------------------------------------------

// Run one scheduled agent turn over the gateway's own /v1 chat endpoint. A
// fresh session per beat: the awareness inject supplies all the context, and
// nothing accumulates to overflow the local model's window.
async function runTurn(entry) {
  const { token, port } = gatewayAuth();
  if (!token) throw new Error("no gateway token");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    if (entry.model) headers["x-openclaw-model"] = String(entry.model);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "openclaw",
        user: `heartbeat-${entry.id}-${Date.now().toString(36)}`,
        stream: false,
        messages: [{ role: "user", content: entry.prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const body = await res.json();
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") throw new Error("no reply content");
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

// Push to the phone through butler-approvals' generic notify action — the same
// route reminders and finished builds already use.
async function sendNotify(title, body) {
  const { token, port } = gatewayAuth();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "notify", title, body, channel: "reminders", data: { type: "reminder" } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runBeat(entry) {
  const started = Date.now();
  try {
    const reply = await runTurn(entry);
    const { deliver, body } = shouldDeliver(reply, entry.mode);
    if (deliver) {
      const pushed = await sendNotify(entry.title || personaNames().butler, body);
      log({ id: entry.id, status: pushed ? "delivered" : "push-failed", chars: body.length, ms: Date.now() - started });
      return { ok: true, delivered: pushed, chars: body.length };
    }
    log({ id: entry.id, status: "silent", chars: reply.trim().length, ms: Date.now() - started });
    return { ok: true, delivered: false, chars: reply.trim().length };
  } catch (err) {
    log({ id: entry.id, status: "fail", error: String(err?.message ?? err), ms: Date.now() - started });
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function sweep() {
  if (running) return;
  const { entries, quietHours } = loadConfig();
  const state = readState();
  const now = new Date();
  const due = entries.find((e) => isDue(e, state.lastRun?.[e.id], now, quietHours));
  if (!due) return;
  // Mark before running so a slow turn can't double-fire on the next sweep.
  state.lastRun = { ...(state.lastRun ?? {}), [due.id]: now.getTime() };
  writeState(state);
  running = true;
  try {
    await runBeat(due);
  } finally {
    running = false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export default {
  id: "butler-heartbeat",
  name: "Butler Heartbeat",
  description: "Scheduled agent check-ins that push to the phone, plus a notify_owner tool for unprompted messages.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    ensureDir();
    if (!sweepTimer) sweepTimer = setInterval(() => sweep().catch(() => {}), SWEEP_MS);

    // The unprompted voice: any turn can decide the owner should hear something now.
    if (typeof api.registerTool === "function") {
      const names = personaNames();
      const ownerRef = names.owner || "your human";
      api.registerTool({
        name: "notify_owner",
        description:
          `Send a push notification to ${ownerRef}'s phone right now. Use this when something genuinely ` +
          "matters in the moment — a job finished or failed, something they asked to be told about, " +
          "or anything time-sensitive they'd want to know even if they aren't looking at the chat. " +
          "Keep the message short; it appears on their lock screen.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "The notification text (short, plain language)." },
            title: { type: "string", description: "Optional notification title. Defaults to your name." },
          },
          required: ["message"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const body = String(params?.message ?? "").trim().slice(0, MAX_PUSH_CHARS);
          if (!body) return { content: [{ type: "text", text: "Nothing to send — message was empty." }] };
          const ok = await sendNotify(String(params?.title ?? "").trim() || personaNames().butler, body);
          return { content: [{ type: "text", text: ok ? "Sent — it's on their phone." : "Couldn't send the push (gateway notify failed)." }] };
        },
      });
    }

    // App/testing surface. POST /api/v1/heartbeat
    //   {action:"list"}            → entries + lastRun
    //   {action:"run", id}         → fire a beat now (awaits the turn)
    api.registerHttpRoute({
      path: "/api/v1/heartbeat",
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
        const { entries, quietHours } = loadConfig();
        if (body.action === "list") {
          const state = readState();
          return send(200, {
            entries: entries.map((e) => ({ ...e, lastRun: state.lastRun?.[e.id] ?? null })),
            quietHours,
          });
        }
        if (body.action === "run") {
          const entry = entries.find((e) => e.id === body.id);
          if (!entry) return send(400, { error: `No heartbeat entry '${body.id}'` });
          const state = readState();
          state.lastRun = { ...(state.lastRun ?? {}), [entry.id]: Date.now() };
          writeState(state);
          const result = await runBeat(entry);
          return send(result.ok ? 200 : 500, result);
        }
        return send(400, { error: "Unknown action" });
      },
    });
  },
};
