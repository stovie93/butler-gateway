// Butler brain: optional cloud-brain escalation for the local model.
//
// The local model is capable but small. Claude Code — installed on this PC for
// dispatched builds — is also a much stronger *answerer*. This plugin lets the
// butler hand a genuinely hard question up to it, with the user in the loop:
//
//  1. A before_prompt_build nudge teaches the model the ASK action marker:
//     [[ASK: question=<self-contained question>]] on the last line of a reply.
//     Text generation is what a 20B model does reliably; tool-calling isn't —
//     same pattern as the [[BUILD]] marker.
//  2. The app turns the marker into a tap-to-ask card. The TAP is the consent:
//     escalation uses the owner's Claude subscription, so the model never
//     escalates on its own.
//  3. POST /api/v1/brain {action:"ask"} runs `claude -p` headless in the
//     background, records the answer, and pushes it to the phone when done
//     (the app also polls {action:"get"} to fill the answer into the chat).
//
// Everything is config-driven and degrades cleanly: no Claude CLI on the
// machine → no nudge is injected and "ask" returns a friendly error.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG_FILE = join(HOME, ".openclaw", "openclaw.json");
const BRAIN_DIR = join(HOME, ".openclaw", "workspace", "brain");
const SCRATCH_DIR = join(BRAIN_DIR, "scratch"); // empty cwd for the claude process
const AUDIT_FILE = join(HOME, ".openclaw", "workspace", "brain-audit.log");

const DEFAULTS = {
  timeoutMs: 300_000, // claude -p on a hard question can legitimately take minutes
  maxAnswerChars: 6_000,
  nudge: true,
};
const PUSH_CHARS = 800;
const MAX_QUESTION_CHARS = 2_000;
const MIN_QUESTION_CHARS = 4;
const MAX_RUNNING = 2;
const KEEP_RECORDS = 100;

// ---- small utils -------------------------------------------------------------

function readJson(file) {
  try {
    let raw = readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ensureDirs() {
  if (!existsSync(SCRATCH_DIR)) mkdirSync(SCRATCH_DIR, { recursive: true });
}

function gatewayAuth() {
  const cfg = readJson(CONFIG_FILE);
  return { token: cfg?.gateway?.auth?.token ?? null, port: cfg?.gateway?.port ?? 18789 };
}

function loadConfig() {
  const c = readJson(CONFIG_FILE)?.plugins?.entries?.["butler-brain"]?.config ?? {};
  return {
    timeoutMs: Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : DEFAULTS.timeoutMs,
    maxAnswerChars: Number(c.maxAnswerChars) > 0 ? Number(c.maxAnswerChars) : DEFAULTS.maxAnswerChars,
    nudge: c.nudge !== false,
    model: typeof c.model === "string" && c.model.trim() ? c.model.trim() : null,
  };
}

function audit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

// Same gate as the other prompt-injection plugins: only real interactive turns
// (the gateway's internal boot checks also report trigger==="user").
function isInteractive(ctx) {
  if (!ctx || ctx.trigger !== "user") return false;
  if (!ctx.sessionKey && !ctx.sessionId) return false;
  if ((ctx.messageProvider ?? "").trim().toLowerCase() === "webchat") return true;
  return Boolean(ctx.channelId && ctx.channelId.trim());
}

// The Claude Code CLI ships a native exe under the npm global tree — spawn it
// directly (shell:false, question over stdin) so nothing is ever shell-parsed.
function claudeExe() {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const exe = join(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(exe) ? exe : null;
}

// ---- pure helpers (unit-tested) ----------------------------------------------

/**
 * Detect an explicit "hand this to Claude" intent in the user's message. The
 * opportunistic nudge relies on the small model judging its own limits — which
 * it does badly (it confidently answers everything). When the user SAYS to
 * escalate, we inject a hard directive instead, so that path always works.
 */
export function extractEscalation(prompt) {
  const p = String(prompt ?? "");
  return /\b(?:ask|go ask|check with|confirm with|verify with|run (?:this|that|it) (?:by|past)|hand (?:this|that|it) (?:to|off to)|escalate (?:this |that |it )?to|get)\s+(?:claude|the (?:big|cloud) brain|your (?:big|cloud) brain)\b/i.test(p);
}

/** Trim + sanity-check a question. Returns {ok, question} or {ok:false, error}. */
export function validateQuestion(raw) {
  const q = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (q.length < MIN_QUESTION_CHARS) return { ok: false, error: "Question is empty or too short." };
  if (q.length > MAX_QUESTION_CHARS) return { ok: false, error: `Question is too long (max ${MAX_QUESTION_CHARS} chars).` };
  return { ok: true, question: q };
}

/** Cap text once, with an ellipsis, for records and push bodies. */
export function capText(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Shape a finished record for the app (never leaks internals). */
export function publicRecord(r) {
  if (!r) return null;
  const out = { id: r.id, question: r.question, status: r.status, createdAt: r.createdAt };
  if (r.status === "done") {
    out.answer = r.answer;
    out.ms = r.ms;
  }
  if (r.status === "failed") out.error = r.error ?? "Claude couldn't answer.";
  return out;
}

// ---- records -------------------------------------------------------------------

function recordFile(id) {
  return join(BRAIN_DIR, `${id}.json`);
}

function saveRecord(r) {
  try {
    ensureDirs();
    writeFileSync(recordFile(r.id), JSON.stringify(r, null, 2), "utf8");
  } catch {}
}

function loadRecord(id) {
  if (!/^[a-z0-9-]+$/.test(String(id ?? ""))) return null;
  return readJson(recordFile(id));
}

function listRecords(limit = 20) {
  try {
    ensureDirs();
    return readdirSync(BRAIN_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(join(BRAIN_DIR, f)))
      .filter(Boolean)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function pruneRecords() {
  try {
    const all = listRecords(Infinity);
    for (const r of all.slice(KEEP_RECORDS)) {
      try { unlinkSync(recordFile(r.id)); } catch {}
    }
  } catch {}
}

// ---- the escalation ------------------------------------------------------------

let _running = 0;

// Push to the phone via butler-approvals' generic notify action.
async function sendNotify(title, body, id) {
  const { token, port } = gatewayAuth();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "notify", title, body, channel: "brain", data: { type: "brain", id } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Run `claude -p` headless with the question on stdin. Resolves when the record
// is final; never rejects. Deliberately does NOT skip permissions: in -p mode
// tool requests auto-deny, so it answers from knowledge instead of touching files.
function runAsk(record, cfg) {
  return new Promise((resolve) => {
    const exe = claudeExe();
    const started = Date.now();
    const finish = (patch) => {
      Object.assign(record, patch, { finishedAt: new Date().toISOString(), ms: Date.now() - started });
      saveRecord(record);
      audit({ id: record.id, status: record.status, ms: record.ms, question: capText(record.question, 200) });
      if (record.status === "done") {
        sendNotify("🧠 Claude answered", capText(record.answer, PUSH_CHARS), record.id).catch(() => {});
      }
      _running = Math.max(0, _running - 1);
      resolve(record);
    };
    if (!exe) {
      finish({ status: "failed", error: "Claude Code isn't installed on this PC." });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    try {
      ensureDirs();
      const args = ["-p", "--output-format", "text"];
      if (cfg.model) args.push("--model", cfg.model);
      const child = spawn(exe, args, { cwd: SCRATCH_DIR, windowsHide: true, shell: false });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill(); } catch {}
        finish({ status: "failed", error: `Claude didn't answer within ${Math.round(cfg.timeoutMs / 1000)}s.` });
      }, cfg.timeoutMs);
      child.stdout.on("data", (d) => { if (out.length < cfg.maxAnswerChars * 2) out += d; });
      child.stderr.on("data", (d) => { if (err.length < 2_000) err += d; });
      child.on("error", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        finish({ status: "failed", error: "Couldn't start the Claude CLI." });
      });
      child.on("close", (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const answer = capText(out, cfg.maxAnswerChars);
        if (code === 0 && answer) finish({ status: "done", answer });
        else finish({ status: "failed", error: capText(err, 300) || `Claude exited with code ${code}.` });
      });
      child.stdin.write(record.question);
      child.stdin.end();
    } catch {
      if (!done) finish({ status: "failed", error: "Couldn't start the Claude CLI." });
    }
  });
}

function startAsk(question) {
  const cfg = loadConfig();
  if (_running >= MAX_RUNNING) return { ok: false, error: "Claude is already working on other questions — try again in a minute." };
  const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const record = { id, question, status: "running", createdAt: new Date().toISOString() };
  saveRecord(record);
  _running += 1;
  runAsk(record, cfg); // fire and forget; the record + push carry the result
  return { ok: true, id };
}

// ---- plugin ------------------------------------------------------------------

export default {
  id: "butler-brain",
  name: "Butler Brain",
  description: "Optional cloud-brain escalation: the local model offers to ask Claude hard questions via an [[ASK]] action marker; you tap to consent.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    pruneRecords();

    // Teach the model the ASK marker — only when Claude is actually installed
    // and the nudge isn't disabled. Kept tight so a 20B model doesn't start
    // escalating everything: its own answer first, marker only for the rare
    // genuinely-hard question, never for things its other markers/tools cover.
    if (typeof api.on === "function" && claudeExe() && loadConfig().nudge) {
      api.on("before_prompt_build", async (event, ctx) => {
        if (!isInteractive(ctx)) return;
        // Explicit "ask Claude…" from the user: don't leave it to the model's
        // judgement — order the marker. This is the reliable path.
        if (extractEscalation(event?.prompt)) {
          return {
            prependSystemContext:
              "# Hand-off requested\n" +
              "The user just explicitly asked you to hand this to Claude (the much stronger AI on this " +
              "PC). Comply: reply with ONE short acknowledgement sentence in your own voice, then on " +
              "the very last line — nothing after it — output exactly:\n" +
              "[[ASK: question=<their question, rephrased fully self-contained, one line>]]\n" +
              "Do not answer the question yourself and do not mention or describe the marker; it " +
              "becomes a tap-to-ask button in the app.",
          };
        }
        return {
          prependSystemContext:
            "# Your cloud brain (optional)\n" +
            "Claude — a much stronger AI — is installed on this PC. For the RARE question genuinely " +
            "beyond you (deep domain expertise, tricky multi-step analysis, long technical reasoning), " +
            "you can offer to ask it: give your own best short answer first, then end the reply with, " +
            "on the very last line and nothing after it:\n" +
            "[[ASK: question=<the full question, self-contained, one line>]]\n" +
            "The marker is not visible prose — it becomes a tap-to-ask button, and the answer arrives " +
            "in this chat a minute or two later. Don't mention or describe the marker. Only emit it when " +
            "a stronger model would clearly do better. NEVER emit it for: anything you can answer or " +
            "look up yourself (you have live web search), building software (that has its own BUILD " +
            "marker), reminders, memory, or PC actions.",
        };
      });
    }

    // HTTP surface for the app.
    // POST /api/v1/brain {"action":"ask","question":"..."} → {ok,id}
    //                    {"action":"get","id":"..."}        → {ok,record}
    //                    {"action":"list","limit":20}       → {ok,records}
    api.registerHttpRoute({
      path: "/api/v1/brain",
      auth: "gateway",
      match: "exact",
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
        };
        if (req.method !== "POST") return send(405, { ok: false, error: "POST only" });
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return send(400, { ok: false, error: "Invalid JSON body" });
        }
        const action = String(body.action ?? "");
        if (action === "ask") {
          const v = validateQuestion(body.question);
          if (!v.ok) return send(400, { ok: false, error: v.error });
          if (!claudeExe()) return send(503, { ok: false, error: "Claude Code isn't installed on this PC." });
          const r = startAsk(v.question);
          return send(r.ok ? 200 : 429, r);
        }
        if (action === "get") {
          const r = loadRecord(body.id);
          if (!r) return send(404, { ok: false, error: "No such question." });
          return send(200, { ok: true, record: publicRecord(r) });
        }
        if (action === "list") {
          const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
          return send(200, { ok: true, records: listRecords(limit).map(publicRecord) });
        }
        return send(400, { ok: false, error: "Unknown action" });
      },
    });
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
