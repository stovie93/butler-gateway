import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";

// Butler reminders: set a nudge in plain language ("remind me to call mum in 2
// hours", "at 6pm", "tomorrow at 9am"). It's parsed, persisted to disk, and a
// scheduler fires it when due — a native Windows toast (reusing the approvals
// toast pattern) AND/OR a WhatsApp message to your phone. Reminders survive a
// gateway restart (re-scheduled on load; overdue ones fire on startup). Three
// surfaces: the set_reminder/list_reminders/cancel_reminder agent tools (natural
// language), a /remind command, and an HTTP route for the app's Reminders screen.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const REMINDERS_DIR = join(WORKSPACE, "reminders");
const AUDIT_FILE = join(WORKSPACE, "dispatch-audit.log");
const CONFIG_FILE = join(HOME, ".openclaw", "openclaw.json");
// Device push tokens registered by the Butler app (via butler-approvals). We
// only read this to push fired reminders to the phone — no registration here.
const PUSH_TOKENS_FILE = join(WORKSPACE, "push-tokens.json");
const NOTIFICATIONS_FILE = join(WORKSPACE, "notifications.jsonl");

// A single sweep interval (started at load time) fires any due reminders. One
// load-time timer beats per-reminder setTimeouts: it survives restarts (overdue
// reminders fire on the next sweep), needs no long-delay chunking, and doesn't
// rely on timers registered mid-request surviving after the response closes.
const SWEEP_MS = 10_000;
let sweepTimer = null;

// Config captured at register() time so module-level fire/deliver can use it.
let _cfg = { pcNotify: true, whatsappNotify: false, whatsappTarget: "", pushNotify: false, fcm: null };

// Cached FCM OAuth access token (minted from the service-account key).
let _fcmToken = { value: null, exp: 0 };

// ---- store helpers ---------------------------------------------------------

function readJson(file) {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function ensureDir() {
  if (!existsSync(REMINDERS_DIR)) mkdirSync(REMINDERS_DIR, { recursive: true });
}

function recordPath(id) {
  return join(REMINDERS_DIR, `${id}.json`);
}

function appendAudit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

function loadConfig() {
  const root = readJson(CONFIG_FILE) ?? {};
  const c = root?.plugins?.entries?.["butler-reminders"]?.config ?? {};
  const whatsappTarget = typeof c.whatsappTarget === "string" ? c.whatsappTarget.trim() : "";
  const fcm =
    c.fcm && typeof c.fcm === "object" && c.fcm.projectId && c.fcm.serviceAccountPath
      ? { projectId: String(c.fcm.projectId), serviceAccountPath: String(c.fcm.serviceAccountPath) }
      : null;
  return {
    pcNotify: c.pcNotify !== false, // PC toast on by default
    // WhatsApp only when a target is configured AND not explicitly disabled.
    whatsappNotify: c.whatsappNotify === true && Boolean(whatsappTarget),
    whatsappTarget,
    // Phone push on by default *when* FCM is configured (the app-first path).
    pushNotify: c.pushNotify !== false && Boolean(fcm),
    fcm,
  };
}

// Sortable id: yyyymmdd-HHMMSSmmm + random suffix (lexicographic == chronological).
function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---- pure time parsing (unit-tested) ---------------------------------------

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, wk: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

// Parse a clock string like "6pm", "6:30pm", "18:00", "9am", "14". Returns
// { h, min } in 24h, or null if it isn't a clock.
function parseClock(raw) {
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

// Next future instant at the given clock today, else tomorrow.
function nextOccurrence(now, clock) {
  const d = new Date(now);
  d.setHours(clock.h, clock.min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Turn a "when" phrase into an absolute epoch-ms, or null if unparseable.
// Supports: "in 2 hours" / "2h", "at 6pm", "tomorrow [at 9am]", "today at 5pm",
// and a bare clock "6pm".
function parseWhen(raw, now = Date.now()) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;

  // "in N unit"  /  bare "N unit"
  let m = s.match(/^(?:in\s+)?(\d+)\s*([a-z]+)$/);
  if (m && UNIT_MS[m[2]]) return now + parseInt(m[1], 10) * UNIT_MS[m[2]];

  // "tomorrow [at TIME]"  (defaults to 9am)
  m = s.match(/^tomorrow(?:\s+at\s+(.+))?$/);
  if (m) {
    const clock = m[1] ? parseClock(m[1]) : { h: 9, min: 0 };
    if (!clock) return null;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(clock.h, clock.min, 0, 0);
    return d.getTime();
  }

  // "today at TIME"  (may be in the past; caller validates)
  m = s.match(/^today\s+at\s+(.+)$/);
  if (m) {
    const clock = parseClock(m[1]);
    if (!clock) return null;
    const d = new Date(now);
    d.setHours(clock.h, clock.min, 0, 0);
    return d.getTime();
  }

  // "at TIME"  → next occurrence
  m = s.match(/^at\s+(.+)$/);
  if (m) {
    const clock = parseClock(m[1]);
    return clock ? nextOccurrence(now, clock) : null;
  }

  // bare clock, e.g. "6pm"
  const clock = parseClock(s);
  return clock ? nextOccurrence(now, clock) : null;
}

// Split a free-form reminder line into { when, text }. Prefers an explicit
// "<when> | <message>" pipe; otherwise sniffs a time phrase out of the sentence
// and treats the rest as the message. Used by the /remind command (the agent
// tool gets when/text as separate params, so it skips this).
function extractReminder(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { when: "", text: "" };

  if (s.includes("|")) {
    const i = s.indexOf("|");
    return { when: s.slice(0, i).trim(), text: s.slice(i + 1).trim() };
  }

  const patterns = [
    /\bin\s+\d+\s*[a-z]+\b/i,
    /\btomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
    /\btoday\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
    /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) {
      const when = m[0].trim();
      let text = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim();
      // strip a leading "remind me", "me", "to" left over from the sentence
      text = text.replace(/^remind\s+me\b/i, "").replace(/^\s*me\b/i, "").replace(/^\s*to\b/i, "");
      text = text.replace(/\s{2,}/g, " ").trim();
      return { when, text };
    }
  }
  return { when: "", text: s };
}

// Short human relative label like "in 5 min" / "in 2h 10m" / "now".
function relativeLabel(fireAt, now = Date.now()) {
  let diff = Math.round((fireAt - now) / 1000);
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400); diff -= d * 86400;
  const h = Math.floor(diff / 3600); diff -= h * 3600;
  const mn = Math.floor(diff / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mn && !d) parts.push(`${mn}m`);
  if (!parts.length) parts.push("<1m");
  return "in " + parts.join(" ");
}

// ---- delivery --------------------------------------------------------------

// Native Windows toast (zero deps — hidden PowerShell building a WinRT toast).
// Title/body via env vars so reminder text can't break out of the script.
// Best-effort, never throws, no-op off Windows.
function notifyPc(title, body) {
  if (process.platform !== "win32") return;
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
    "[Windows.UI.Notifications.ToastNotification,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null",
    "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t=$x.GetElementsByTagName('text')",
    "$t.Item(0).AppendChild($x.CreateTextNode($env:BUTLER_TOAST_TITLE))|Out-Null",
    "$t.Item(1).AppendChild($x.CreateTextNode($env:BUTLER_TOAST_BODY))|Out-Null",
    "$n=[Windows.UI.Notifications.ToastNotification]::new($x)",
    "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($n)",
  ].join(";");
  try {
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        env: { ...process.env, BUTLER_TOAST_TITLE: String(title).slice(0, 120), BUTLER_TOAST_BODY: String(body).slice(0, 240) },
        windowsHide: true,
        stdio: "ignore",
      },
    );
    ps.on("error", () => {});
    ps.unref();
  } catch {}
}

// Resolve the OpenClaw CLI's JS entry so we can run it via `node` directly
// (shell:false, args array → no shell-escaping/injection from reminder text).
function cliEntry() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const entry = join(appdata, "npm", "node_modules", "openclaw", "openclaw.mjs");
  return existsSync(entry) ? entry : null;
}

// Send a WhatsApp message to the configured target via the OpenClaw CLI.
// Fire-and-forget; never throws.
function sendWhatsApp(message) {
  const target = _cfg.whatsappTarget;
  if (!target) return;
  const entry = cliEntry();
  try {
    const args = entry
      ? [entry, "message", "send", "--channel", "whatsapp", "--target", target, "-m", message]
      : ["message", "send", "--channel", "whatsapp", "--target", target, "-m", message];
    const cmd = entry ? process.execPath : "openclaw";
    const ps = spawn(cmd, args, { windowsHide: true, stdio: "ignore", shell: !entry });
    ps.on("error", () => {});
    ps.unref();
  } catch {}
}

// ---- FCM push (phone notification, reaches a fully-closed app) -------------
// Reuses the device-token store the Butler app registers via butler-approvals
// (~/.openclaw/workspace/push-tokens.json) — reminders only read it. Node crypto
// only (RS256 JWT → OAuth token → FCM v1 send). Best-effort; never throws.

function loadTokens() {
  const data = readJson(PUSH_TOKENS_FILE);
  return Array.isArray(data) ? data : [];
}

function removeToken(token) {
  const tokens = loadTokens();
  const filtered = tokens.filter((t) => t.token !== token);
  if (filtered.length !== tokens.length) {
    try {
      writeJson(PUSH_TOKENS_FILE, filtered);
    } catch {}
  }
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Pure: the signed JWT claim set for the FCM service-account OAuth exchange.
function buildJwtClaims(sa, now = Math.floor(Date.now() / 1000)) {
  return {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
}

// Mint (and cache ~55 min) an OAuth access token from the service-account key.
// Returns null on any failure (push then no-ops).
async function getFcmAccessToken() {
  const fcm = _cfg.fcm;
  if (!fcm) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_fcmToken.value && _fcmToken.exp - 300 > now) return _fcmToken.value;

  let sa;
  try {
    sa = JSON.parse(readFileSync(fcm.serviceAccountPath, "utf8"));
  } catch {
    return null; // SA file missing/unreadable → push disabled
  }
  if (!sa.client_email || !sa.private_key) return null;

  const signingInput =
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + base64url(JSON.stringify(buildJwtClaims(sa, now)));
  let jwt;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    jwt = signingInput + "." + base64url(signer.sign(sa.private_key));
  } catch {
    return null;
  }

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "grant_type=" +
        encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
        "&assertion=" +
        encodeURIComponent(jwt),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.access_token) return null;
    _fcmToken = { value: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
    return _fcmToken.value;
  } catch {
    return null;
  }
}

// Push a fired reminder to every registered device. Tapping opens the Remind
// tab (data.type=reminder). Dead tokens pruned on 404/400. Never throws.
async function sendReminderPush(record) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), type: "reminder", title: "⏰ Reminder", body: String(record.text || "") });
    appendFileSync(NOTIFICATIONS_FILE, line + "\n", "utf8");
  } catch {}
  const fcm = _cfg.fcm;
  if (!fcm?.projectId) return;
  const tokens = loadTokens();
  if (!tokens.length) return;
  const accessToken = await getFcmAccessToken();
  if (!accessToken) return;

  const title = "⏰ Reminder";
  const body = String(record.text).slice(0, 240);
  const url = `https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`;

  for (const t of tokens) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: t.token,
            notification: { title, body },
            data: { type: "reminder", reminderId: String(record.id) },
            android: { priority: "high", notification: { channel_id: "reminders" } },
          },
        }),
      });
      if (res.status === 404 || res.status === 400) removeToken(t.token);
    } catch {}
  }
}

function deliver(record) {
  if (_cfg.pcNotify) notifyPc("Butler reminder", record.text);
  if (_cfg.pushNotify) sendReminderPush(record).catch(() => {});
  if (_cfg.whatsappNotify) sendWhatsApp(`Reminder: ${record.text}`);
}

// ---- scheduler -------------------------------------------------------------

// Fire every pending reminder whose time has arrived. Re-reads each record so a
// reminder cancelled since the last sweep is skipped. Best-effort; never throws.
function fireDue() {
  const now = Date.now();
  for (const record of listReminders()) {
    if (record.fireAt > now) continue;
    record.status = "fired";
    record.firedAt = new Date().toISOString();
    try {
      writeJson(recordPath(record.id), record);
    } catch {
      continue; // couldn't persist — leave pending, retry next sweep
    }
    appendAudit({ action: "reminder.fire", id: record.id, text: record.text });
    deliver(record);
  }
}

// Start the load-time sweep (idempotent). Fires due reminders now (catching any
// that came due while the gateway was down), then every SWEEP_MS.
function startSweep() {
  if (sweepTimer) return;
  try {
    fireDue();
  } catch {}
  sweepTimer = setInterval(() => {
    try {
      fireDue();
    } catch {}
  }, SWEEP_MS);
}

// ---- store operations ------------------------------------------------------

function listReminders(includeDone = false) {
  if (!existsSync(REMINDERS_DIR)) return [];
  return readdirSync(REMINDERS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(REMINDERS_DIR, f)))
    .filter((r) => r && (includeDone || r.status === "pending"))
    .sort((a, b) => a.fireAt - b.fireAt);
}

// Create + schedule a reminder. Returns { ok, record?, error? }.
function addReminder(text, when) {
  const body = String(text ?? "").trim();
  if (!body) return { ok: false, error: "What should I remind you about?" };
  const fireAt = parseWhen(when);
  if (fireAt == null) {
    return { ok: false, error: `Couldn't understand the time "${when}". Try "in 2 hours", "at 6pm", or "tomorrow at 9am".` };
  }
  if (fireAt <= Date.now()) {
    return { ok: false, error: "That time is in the past." };
  }
  ensureDir();
  const id = newId();
  const record = {
    id,
    text: body.slice(0, 500),
    when: String(when).trim(),
    fireAt,
    fireAtISO: new Date(fireAt).toISOString(),
    status: "pending",
    createdAt: new Date().toISOString(),
    firedAt: null,
  };
  writeJson(recordPath(id), record);
  appendAudit({ action: "reminder.add", id, text: record.text, when: record.when });
  // The load-time sweep picks it up; no per-reminder timer needed.
  return { ok: true, record };
}

// Cancel a pending reminder by id (or a unique id prefix). Returns { ok, record?, error? }.
function cancelReminder(idOrPrefix) {
  const key = String(idOrPrefix ?? "").trim();
  if (!key) return { ok: false, error: "Need a reminder id." };
  const pending = listReminders();
  const matches = pending.filter((r) => r.id === key || r.id.startsWith(key));
  if (matches.length === 0) return { ok: false, error: "No matching pending reminder." };
  if (matches.length > 1) return { ok: false, error: `Ambiguous — ${matches.length} reminders match "${key}".` };
  const record = matches[0];
  record.status = "cancelled";
  record.cancelledAt = new Date().toISOString();
  writeJson(recordPath(record.id), record);
  appendAudit({ action: "reminder.cancel", id: record.id });
  return { ok: true, record };
}

// On startup: prune old terminal records. Pending ones are left for the sweep,
// which fires any that are already overdue on its first tick.
function prune({ maxAgeDays = 14 } = {}) {
  if (!existsSync(REMINDERS_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  for (const f of readdirSync(REMINDERS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const file = join(REMINDERS_DIR, f);
    const r = readJson(file);
    if (!r || r.status === "pending") continue;
    const t = Date.parse(r.firedAt ?? r.cancelledAt ?? r.createdAt ?? "");
    if (Number.isFinite(t) && t < cutoff) {
      try {
        rmSync(file, { force: true });
      } catch {}
    }
  }
}

// One-line summary for chat/CLI listings.
function summarize(record) {
  return `• ${record.id.slice(0, 13)} — "${record.text}" (${relativeLabel(record.fireAt)}, ${new Date(record.fireAt).toLocaleString()})`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export { parseWhen, parseClock, nextOccurrence, extractReminder, relativeLabel, buildJwtClaims };

export default {
  id: "butler-reminders",
  name: "Butler Reminders",
  description: "Set plain-language reminders that fire a PC toast and/or a WhatsApp message when due.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    _cfg = loadConfig();
    try {
      prune();
    } catch {}
    startSweep(); // fires overdue reminders now, then sweeps every SWEEP_MS

    // Natural-language entry points for the butler agent. The model splits the
    // request into text + when itself, so these skip extractReminder.
    if (typeof api.registerTool === "function") {
      api.registerTool({
        name: "set_reminder",
        description:
          "Set a reminder for the user. Provide what to remind them about (text) and when, in plain " +
          "language: relative like 'in 2 hours' or 'in 30 minutes', a clock time like 'at 6pm' or " +
          "'tomorrow at 9am' or 'today at 5pm'. It fires a notification when due.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "What to remind the user about." },
            when: { type: "string", description: "When to fire, e.g. 'in 2 hours', 'at 6pm', 'tomorrow at 9am'." },
          },
          required: ["text", "when"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const r = addReminder(params?.text, params?.when);
          const text = r.ok
            ? `Reminder set: "${r.record.text}" ${relativeLabel(r.record.fireAt)} (${new Date(r.record.fireAt).toLocaleString()}).`
            : r.error;
          return { content: [{ type: "text", text }] };
        },
      });

      api.registerTool({
        name: "list_reminders",
        description: "List the user's pending (not-yet-fired) reminders.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const pending = listReminders();
          const text = pending.length
            ? "Pending reminders:\n" + pending.map(summarize).join("\n")
            : "No pending reminders.";
          return { content: [{ type: "text", text }] };
        },
      });

      api.registerTool({
        name: "cancel_reminder",
        description: "Cancel a pending reminder by its id (an id prefix is fine). Use list_reminders to find ids.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "The reminder id (or a unique prefix)." } },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const r = cancelReminder(params?.id);
          return { content: [{ type: "text", text: r.ok ? `Cancelled "${r.record.text}".` : r.error }] };
        },
      });
    }

    // HTTP control surface for the Butler app's Reminders screen (gateway auth).
    // POST /api/v1/reminders {action:"list"} | {action:"add", text, when} | {action:"cancel", id}
    api.registerHttpRoute({
      path: "/api/v1/reminders",
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
          return send(200, { reminders: listReminders().map((r) => ({ ...r, relative: relativeLabel(r.fireAt) })) });
        }
        if (body.action === "add") {
          const r = addReminder(body.text, body.when);
          if (!r.ok) return send(400, { error: r.error });
          return send(200, { ok: true, reminder: { ...r.record, relative: relativeLabel(r.record.fireAt) } });
        }
        if (body.action === "cancel") {
          const r = cancelReminder(body.id);
          if (!r.ok) return send(400, { error: r.error });
          return send(200, { ok: true, reminder: r.record });
        }
        return send(400, { error: "Unknown action" });
      },
    });

    // Typed chat command. "/remind <when> | <message>", or a natural sentence
    // ("/remind call mum in 2 hours"). Also: "/remind list", "/remind cancel <id>".
    api.registerCommand({
      name: "remind",
      description:
        "Set a reminder: /remind <when> | <message> (e.g. /remind in 2 hours | call mum). " +
        "Also /remind list and /remind cancel <id>.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const raw = String(ctx.args ?? "").trim();
        if (!raw || raw.toLowerCase() === "list") {
          const pending = listReminders();
          return {
            text: pending.length ? "Pending reminders:\n" + pending.map(summarize).join("\n") : "No pending reminders.",
          };
        }
        const lower = raw.toLowerCase();
        if (lower.startsWith("cancel")) {
          const id = raw.slice(6).trim();
          const r = cancelReminder(id);
          return { text: r.ok ? `Cancelled "${r.record.text}".` : r.error };
        }
        const { when, text } = extractReminder(raw);
        if (!when) {
          return {
            text: "Couldn't find a time. Try: /remind in 2 hours | call mum (or /remind call mum at 6pm).",
          };
        }
        const r = addReminder(text, when);
        return {
          text: r.ok
            ? `Reminder set: "${r.record.text}" ${relativeLabel(r.record.fireAt)} (${new Date(r.record.fireAt).toLocaleString()}).`
            : r.error,
        };
      },
    });
  },
};

