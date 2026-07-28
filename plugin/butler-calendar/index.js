import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKSPACE = join(homedir(), ".openclaw", "workspace");
const CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");
const AUDIT_FILE = join(WORKSPACE, "calendar-audit.log");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";

let cachedToken = null; // { token, expiresAtMs }

function readJson(file) {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function pluginConfigFrom(root) {
  return root?.plugins?.entries?.["butler-calendar"]?.config ?? {};
}

function loadPluginConfig() {
  return pluginConfigFrom(readJson(CONFIG_FILE) ?? {});
}

function ownerRef() {
  const p = readJson(join(WORKSPACE, "persona.json"));
  const o = typeof p?.owner === "string" ? p.owner.trim() : "";
  return o || "the user";
}

function appendAudit(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    // Writing the calendar changes something the owner will see; keep a trail.
    import("node:fs").then(({ appendFileSync }) => appendFileSync(AUDIT_FILE, line, "utf8")).catch(() => {});
  } catch {}
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Service-account JWT. No user consent and no refresh token, so nothing
 *  expires after 7 days the way an unverified OAuth app's tokens do. */
export function buildJwtClaims(clientEmail, nowSec) {
  return {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
}

async function getAccessToken(key) {
  if (cachedToken && cachedToken.expiresAtMs > Date.now() + 60_000) return cachedToken.token;

  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify(buildJwtClaims(key.client_email, nowSec)));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(key.private_key));

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`Token exchange failed: ${body.error_description ?? body.error ?? res.status}`);
  }
  cachedToken = { token: body.access_token, expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.token;
}

/**
 * Resolve a time the model supplied. Accepts a full ISO timestamp (what a model
 * usually produces once it knows the current time) and the handful of plain
 * phrasings it falls back to. Returns epoch millis, or undefined if unparseable —
 * better to ask than to book something at the wrong hour.
 */
export function parseWhen(input, now = new Date()) {
  const raw = String(input ?? "").trim();
  if (!raw) return undefined;

  // A timestamp carrying its own offset or Z is unambiguous; trust it.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : undefined;
  }
  // A local timestamp with no offset: interpret in the host's zone, which is
  // where the owner lives.
  const localMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (localMatch) {
    const [, y, mo, d, h, mi, s] = localMatch.map(Number);
    return new Date(y, mo - 1, d, h, mi, s || 0).getTime();
  }

  const lower = raw.toLowerCase();

  const rel = lower.match(/^in\s+(\d+)\s*(minute|min|hour|hr|day)s?$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    const ms = unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
    return now.getTime() + n * ms;
  }

  const clock = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  const dayWords = { today: 0, tomorrow: 1, tonight: 0 };
  let dayOffset;
  for (const [word, offset] of Object.entries(dayWords)) {
    if (lower.includes(word)) {
      dayOffset = offset;
      break;
    }
  }
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const weekdayIdx = weekdays.findIndex((d) => lower.includes(d));

  if (dayOffset === undefined && weekdayIdx === -1) return undefined;
  if (!clock) return undefined;

  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = clock[3];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  // "tonight at 8" means 20:00, not 08:00.
  if (!meridiem && lower.includes("tonight") && hour < 12) hour += 12;

  const target = new Date(now);
  if (weekdayIdx !== -1) {
    const delta = (weekdayIdx - now.getDay() + 7) % 7 || 7; // "friday" means the next one
    target.setDate(now.getDate() + delta);
  } else {
    target.setDate(now.getDate() + dayOffset);
  }
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

/** Google wants RFC3339 with an offset; send the host's local offset explicitly
 *  so an event booked at 3pm is 3pm where the owner is, not 3pm UTC. */
export function toRfc3339(ms) {
  const d = new Date(ms);
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

function loadKey(config) {
  const path =
    config?.serviceAccountPath || join(homedir(), ".openclaw", "fcm-service-account.json");
  const key = readJson(path);
  if (!key?.client_email || !key?.private_key) {
    throw new Error(`No usable service-account key at ${path}`);
  }
  return key;
}

async function api(config, method, path, body) {
  const key = loadKey(config);
  const token = await getAccessToken(key);
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 404) {
      throw new Error(
        `${msg} — is the calendar shared with ${key.client_email} as "Make changes to events"?`,
      );
    }
    if (res.status === 403 && /has not been used|disabled/i.test(msg)) {
      throw new Error(`${msg}`);
    }
    throw new Error(msg);
  }
  return data;
}

export default {
  id: "butler-calendar",
  name: "Butler Calendar",
  description: "Create and read Google Calendar events via a service account (no OAuth consent, no token expiry).",
  configSchema: { parse: (v) => v ?? {}, safeParse: (v) => ({ success: true, data: v ?? {} }) },
  register(api_) {
    // Read our own config the way every sibling plugin does — register() gets
    // only the api. Taking it as a second parameter silently yielded {}, which
    // defaulted calendarId to "primary": for a service account that is *its own*
    // calendar, so events vanished into an account the owner cannot see.
    const cfg = loadPluginConfig();
    const calendarId = cfg.calendarId || "primary";
    const who = ownerRef();

    if (typeof api_.registerTool !== "function") return;

    api_.registerTool({
      name: "create_event",
      description:
        `Add an event to ${who}'s Google Calendar. Use this whenever they ask to schedule, book, ` +
        "add, or put something on their calendar — an appointment, meeting, reminder with a time, " +
        "or anything that belongs on a specific day. This writes a real event they will see on " +
        "their phone. For a simple nudge with no calendar entry, use set_reminder instead.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title, e.g. 'Dentist'." },
          start: {
            type: "string",
            description:
              "When it starts. Prefer a full ISO timestamp like '2026-08-07T14:00:00' (you know the " +
              "current date and time). Plain phrases like 'tomorrow at 3pm' or 'in 2 hours' also work.",
          },
          durationMinutes: { type: "number", description: "How long, in minutes. Defaults to 60." },
          description: { type: "string", description: "Optional notes on the event." },
          location: { type: "string", description: "Optional location." },
          reminderMinutes: {
            type: "number",
            description: "Minutes before the start to be reminded. Defaults to 10.",
          },
        },
        required: ["summary", "start"],
        additionalProperties: false,
      },
      async execute(_id, params) {
        const summary = String(params?.summary ?? "").trim();
        const startMs = parseWhen(params?.start);
        if (!summary || startMs === undefined) {
          return {
            content: [
              {
                type: "text",
                text: !summary
                  ? "I need a title for the event."
                  : `I couldn't work out when "${params?.start}" is — give me a date and time.`,
              },
            ],
          };
        }
        const minutes = Number(params?.durationMinutes) > 0 ? Number(params.durationMinutes) : 60;
        const remind = Number.isFinite(Number(params?.reminderMinutes)) ? Number(params.reminderMinutes) : 10;
        const endMs = startMs + minutes * 60_000;

        try {
          const created = await api(cfg, "POST", `/calendars/${encodeURIComponent(calendarId)}/events`, {
            summary,
            description: params?.description || undefined,
            location: params?.location || undefined,
            start: { dateTime: toRfc3339(startMs) },
            end: { dateTime: toRfc3339(endMs) },
            reminders: { useDefault: false, overrides: [{ method: "popup", minutes: remind }] },
          });
          appendAudit({ action: "create", summary, start: toRfc3339(startMs), id: created?.id });
          const when = new Date(startMs).toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });
          return { content: [{ type: "text", text: `Added "${summary}" on ${when}.` }] };
        } catch (err) {
          appendAudit({ action: "create.failed", summary, error: String(err?.message ?? err) });
          return { content: [{ type: "text", text: `Couldn't add it: ${err?.message ?? err}` }] };
        }
      },
    });

    api_.registerTool({
      name: "list_events",
      description: `Look at what's coming up on ${who}'s Google Calendar. Use this for "what's on today", "am I free Thursday", or before scheduling something so you don't double-book.`,
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days ahead to look. Defaults to 7." },
        },
        additionalProperties: false,
      },
      async execute(_id, params) {
        const days = Number(params?.days) > 0 ? Number(params.days) : 7;
        const timeMin = new Date().toISOString();
        const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
        try {
          const data = await api(
            cfg,
            "GET",
            `/calendars/${encodeURIComponent(calendarId)}/events?singleEvents=true&orderBy=startTime` +
              `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=25`,
          );
          const items = data?.items ?? [];
          if (items.length === 0) {
            return { content: [{ type: "text", text: `Nothing on the calendar for the next ${days} days.` }] };
          }
          const lines = items.map((e) => {
            const when = e.start?.dateTime
              ? new Date(e.start.dateTime).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : e.start?.date ?? "?";
            return `${when} — ${e.summary ?? "(no title)"}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Couldn't read the calendar: ${err?.message ?? err}` }] };
        }
      },
    });
  },
};
