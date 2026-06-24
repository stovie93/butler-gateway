import { writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The butler agent's sensitive tool calls are gated here: a before_tool_call hook
// creates a pending approval, pushes it to the Butler apps over SSE, and BLOCKS the
// tool until you approve/deny from the app (or a timeout falls back to deny). State
// is file-backed (like code-dispatch jobs) so it's inspectable and survives reads.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const APPROVALS_DIR = join(WORKSPACE, "approvals");
const AUDIT_FILE = join(WORKSPACE, "dispatch-audit.log");
const CONFIG_FILE = join(HOME, ".openclaw", "openclaw.json");

const TERMINAL = ["allowed", "denied", "expired"];
const VALID_DECISIONS = ["allow-once", "deny"];

// In-memory state (lives only for this gateway process):
//   waiters: approvalId -> { resolve(decision), timer }  — the blocked hooks/commands
//   subscribers: Set of (eventName, dataObj) => void      — connected SSE clients
const waiters = new Map();
const subscribers = new Set();

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
  if (!existsSync(APPROVALS_DIR)) mkdirSync(APPROVALS_DIR, { recursive: true });
}

function recordPath(id) {
  return join(APPROVALS_DIR, `${id}.json`);
}

// Append-only audit trail (shared with code-dispatch). Deciding an approval
// authorizes a sensitive action, so every decision is recorded.
function appendAudit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

function loadConfig() {
  const root = readJson(CONFIG_FILE) ?? {};
  const c = root?.plugins?.entries?.["butler-approvals"]?.config ?? {};
  return {
    sensitiveTools: Array.isArray(c.sensitiveTools) ? c.sensitiveTools.map(String) : [],
    defaultSeverity: c.defaultSeverity ?? "warning",
    timeoutMs: typeof c.timeoutMs === "number" && c.timeoutMs >= 1000 ? c.timeoutMs : 120_000,
    timeoutBehavior: c.timeoutBehavior === "allow" ? "allow" : "deny",
    enableTestCommand: Boolean(c.enableTestCommand),
  };
}

// ---- pure helpers (unit-tested) -------------------------------------------

// Glob with * (any run) and ? (one char), anchored. Used to match tool names.
function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function isSensitive(toolName, sensitiveTools) {
  if (!toolName || !Array.isArray(sensitiveTools)) return false;
  return sensitiveTools.some((p) => globToRegExp(p).test(toolName));
}

function isValidDecision(d) {
  return VALID_DECISIONS.includes(d);
}

function decisionToStatus(decision) {
  if (decision === "allow-once") return "allowed";
  if (decision === "deny") return "denied";
  return "expired";
}

// A short, human-readable hint of what the tool was asked to do.
function argsBrief(params) {
  if (!params || typeof params !== "object") return "";
  const v =
    params.summary ?? params.command ?? params.symbol ?? params.query ?? params.prompt ?? params.url ?? params.path;
  let s;
  try {
    s = typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(params);
  } catch {
    s = String(v ?? "");
  }
  s = (s ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

// Sortable id: yyyymmdd-HHMMSSmmm + random suffix (lexicographic == chronological).
function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---- store + lifecycle -----------------------------------------------------

function broadcast(eventName, data) {
  for (const send of subscribers) {
    try {
      send(eventName, data);
    } catch {}
  }
}

function listPending() {
  if (!existsSync(APPROVALS_DIR)) return [];
  return readdirSync(APPROVALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(APPROVALS_DIR, f)))
    .filter((r) => r && r.status === "pending")
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

function listRecent(limit = 30) {
  if (!existsSync(APPROVALS_DIR)) return [];
  return readdirSync(APPROVALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => readJson(join(APPROVALS_DIR, f)))
    .filter(Boolean);
}

function createPending({ toolName, params, severity, agentId, sessionKey, timeoutMs }) {
  ensureDir();
  const id = newId();
  const now = Date.now();
  const record = {
    id,
    toolName,
    title: `Approve: ${toolName}`,
    description: `The butler wants to run “${toolName}”.`,
    severity: severity || "warning",
    argsBrief: argsBrief(params),
    agentId: agentId ?? null,
    sessionKey: sessionKey ?? null,
    status: "pending",
    decision: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + timeoutMs).toISOString(),
    decidedAt: null,
    decidedVia: null,
  };
  writeJson(recordPath(id), record);
  broadcast("pending", record);
  return record;
}

// Persist a terminal outcome and notify subscribers. Returns the updated record.
function finalize(id, decision, via) {
  const record = readJson(recordPath(id));
  if (!record || record.status !== "pending") return record;
  record.status = decisionToStatus(decision);
  record.decision = decision;
  record.decidedAt = new Date().toISOString();
  record.decidedVia = via;
  writeJson(recordPath(id), record);
  broadcast("resolved", record);
  return record;
}

// Block until the approval is decided (by the app, or by timeout fallback).
function awaitDecision(record, timeoutMs, timeoutBehavior) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(record.id);
      const decision = timeoutBehavior === "allow" ? "allow-once" : "deny";
      finalize(record.id, decision, "timeout");
      resolve(decision);
    }, timeoutMs);
    waiters.set(record.id, {
      resolve: (decision) => {
        clearTimeout(timer);
        waiters.delete(record.id);
        finalize(record.id, decision, "app");
        resolve(decision);
      },
      timer,
    });
  });
}

// Apply an app/operator decision. Unblocks the awaiting hook if present.
function submitDecision(id, decision, source) {
  const waiter = waiters.get(id);
  if (waiter) {
    appendAudit({ action: "approval.decide", source, id, decision });
    waiter.resolve(decision); // clears timer, finalizes, unblocks the tool
    return readJson(recordPath(id));
  }
  // No awaiting hook: either already resolved, or orphaned by a restart.
  const record = readJson(recordPath(id));
  if (record && record.status === "pending") {
    appendAudit({ action: "approval.decide", source, id, decision: "expired-orphan" });
    return finalize(id, "expired", "orphan");
  }
  return record; // already terminal, or unknown id
}

// On startup, any record still "pending" was orphaned by the previous process
// (its awaiting hook died), so mark it expired. Then prune old records.
function reconcileAndPrune({ maxAgeDays = 14 } = {}) {
  if (!existsSync(APPROVALS_DIR)) return;
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  for (const f of readdirSync(APPROVALS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const file = join(APPROVALS_DIR, f);
    const r = readJson(file);
    if (!r) continue;
    if (r.status === "pending") {
      r.status = "expired";
      r.decision = "expired";
      r.decidedAt = new Date().toISOString();
      r.decidedVia = "reconcile";
      try {
        writeJson(file, r);
      } catch {}
      continue;
    }
    if (TERMINAL.includes(r.status)) {
      const t = Date.parse(r.decidedAt ?? r.createdAt ?? "");
      if (Number.isFinite(t) && t < cutoff) {
        try {
          rmSync(file, { force: true });
        } catch {}
      }
    }
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

export { globToRegExp, isSensitive, isValidDecision, decisionToStatus, argsBrief };

export default {
  id: "butler-approvals",
  name: "Butler Approvals",
  description:
    "Gate the butler agent's sensitive tool calls behind an approval you grant from the Butler app.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    const cfg = loadConfig();
    try {
      reconcileAndPrune();
    } catch {}

    // Gate sensitive tool calls. Returning {} lets the tool proceed; returning
    // { block: true } aborts it. We await the decision in between.
    api.registerHook("before_tool_call", async (event, ctx) => {
      try {
        if (!isSensitive(event?.toolName, cfg.sensitiveTools)) return;
        const record = createPending({
          toolName: event.toolName,
          params: event.params,
          severity: cfg.defaultSeverity,
          agentId: ctx?.agentId ?? null,
          sessionKey: ctx?.sessionKey ?? null,
          timeoutMs: cfg.timeoutMs,
        });
        const decision = await awaitDecision(record, cfg.timeoutMs, cfg.timeoutBehavior);
        if (decision === "allow-once") return {};
        return { block: true, blockReason: "Denied via Butler approval" };
      } catch {
        // Fail safe: if our gating errors, block rather than silently allow.
        return { block: true, blockReason: "Butler approval error" };
      }
    });

    // HTTP control surface for the Butler apps (gateway token auth).
    // POST /api/v1/approvals  {"action":"list"} | {"action":"decide","id":"...","decision":"allow-once|deny"} | {"action":"history","limit":30}
    api.registerHttpRoute({
      path: "/api/v1/approvals",
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
          return send(200, { approvals: listPending() });
        }
        if (body.action === "history") {
          return send(200, { approvals: listRecent(typeof body.limit === "number" ? body.limit : 30) });
        }
        if (body.action === "decide") {
          if (!body.id) return send(400, { error: "Need id" });
          if (!isValidDecision(body.decision)) return send(400, { error: "decision must be allow-once or deny" });
          const record = submitDecision(String(body.id), body.decision, "http");
          if (!record) return send(404, { error: "No such approval" });
          return send(200, { ok: true, status: record.status, approval: record });
        }
        return send(400, { error: "Unknown action" });
      },
    });

    // Live approval stream (SSE): initial pending snapshot, then pending/resolved events.
    api.registerHttpRoute({
      path: "/api/v1/approvals/stream",
      auth: "gateway",
      match: "exact",
      handler: (req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        const send = (eventName, data) => res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        send("snapshot", { approvals: listPending() });
        subscribers.add(send);

        const beat = setInterval(() => {
          try {
            res.write(`: keepalive\n\n`);
          } catch {}
        }, 20_000);

        const cleanup = () => {
          clearInterval(beat);
          subscribers.delete(send);
        };
        req.on("close", cleanup);
        return true;
      },
    });

    // Opt-in test command: drives the exact approval path without a real gated
    // tool, so the app loop can be exercised end-to-end.
    if (cfg.enableTestCommand) {
      api.registerCommand({
        name: "test-approval",
        description: "Create a test approval and wait for your decision from the Butler app: /test-approval [summary]",
        acceptsArgs: true,
        handler: async (ctx) => {
          const summary = (ctx.args ?? "").trim() || "test action";
          const record = createPending({
            toolName: "test-approval",
            params: { summary },
            severity: cfg.defaultSeverity,
            timeoutMs: cfg.timeoutMs,
          });
          const decision = await awaitDecision(record, cfg.timeoutMs, cfg.timeoutBehavior);
          return {
            text:
              decision === "allow-once"
                ? `Approved — would proceed with: ${summary}`
                : `Denied — not proceeding with: ${summary}`,
          };
        },
      });
    }
  },
};
