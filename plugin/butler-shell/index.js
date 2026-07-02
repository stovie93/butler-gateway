import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler shell: general hands, safely. The run_command tool lets the butler
// propose ANY command — and none of it executes until the exact command text is
// approved from the phone (or PC toast) through the approval relay. The safety
// property is structural, not behavioral: it does not depend on the model being
// smart or aligned, only on the human tapping Approve. Deny (or timeout, or the
// relay being unreachable) means nothing runs — fail closed.

const HOME = homedir();
const WORKSPACE = join(HOME, ".openclaw", "workspace");
const AUDIT_FILE = join(WORKSPACE, "shell-audit.log");
const CONFIG_FILE = join(HOME, ".openclaw", "openclaw.json");

const DEFAULTS = {
  timeoutMs: 90_000, // hard cap on command runtime
  maxOutputChars: 8_000, // what the model gets back
  maxCommandChars: 4_000,
};

// ---- small helpers ----------------------------------------------------------

function readJson(file) {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function loadConfig() {
  const c = readJson(CONFIG_FILE)?.plugins?.entries?.["butler-shell"]?.config ?? {};
  return {
    timeoutMs: Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 ? c.timeoutMs : DEFAULTS.timeoutMs,
    maxOutputChars:
      Number.isFinite(c.maxOutputChars) && c.maxOutputChars > 0 ? c.maxOutputChars : DEFAULTS.maxOutputChars,
    cwd: typeof c.cwd === "string" && c.cwd.trim() ? c.cwd.trim() : HOME,
  };
}

function audit(entry) {
  try {
    if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

function gatewayAuth() {
  const cfg = readJson(CONFIG_FILE);
  return { token: cfg?.gateway?.auth?.token ?? null, port: cfg?.gateway?.port ?? 18789 };
}

// ---- pure helpers (unit-tested) ----------------------------------------------

/** Reject empty/oversized commands before they even reach the approval card. */
export function validateCommand(raw, maxChars = DEFAULTS.maxCommandChars) {
  const command = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!command) return { ok: false, error: "Empty command." };
  if (command.length > maxChars) return { ok: false, error: `Command too long (${command.length} > ${maxChars} chars).` };
  return { ok: true, command };
}

/** Append a chunk to accumulated output, capping total size once. */
export function capAppend(current, chunk, max) {
  if (current.length >= max) return current;
  const next = current + chunk;
  return next.length > max ? next.slice(0, max) + "\n…(output truncated)" : next;
}

/** Render an execution result as the text the model (or app) gets back. */
export function formatResult(r) {
  if (r.error) return `⚠ Failed to run: ${r.error}`;
  const parts = [];
  parts.push(r.timedOut ? `⏱ Timed out after ${Math.round(r.timeoutMs / 1000)}s (process killed).` : `Exit code ${r.exitCode}.`);
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trim()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push("(no output)");
  return parts.join("\n\n");
}

// ---- the gate + the hands -----------------------------------------------------

// Ask butler-approvals to put the exact command on Jordan's phone and block
// until he decides. Anything but an explicit allow — deny, timeout, relay
// unreachable — reads as false. Fail closed, always.
async function requireApproval(command, cwd) {
  const { token, port } = gatewayAuth();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "request", toolName: "run_command", params: { command, cwd } }),
    });
    const data = await res.json();
    return data?.decision === "allow-once";
  } catch {
    return false;
  }
}

function execCommand(command, { cwd, timeoutMs, maxOutputChars }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
        { cwd, windowsHide: true, shell: false },
      );
    } catch (err) {
      resolve({ error: String(err?.message ?? err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {}
    }, timeoutMs);
    child.stdout?.on("data", (c) => (stdout = capAppend(stdout, c.toString("utf8"), maxOutputChars)));
    child.stderr?.on("data", (c) => (stderr = capAppend(stderr, c.toString("utf8"), maxOutputChars)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, timeoutMs });
    });
  });
}

// The single entry point every surface goes through: validate → approve → run.
async function gatedRun(rawCommand, rawCwd) {
  const cfg = loadConfig();
  const v = validateCommand(rawCommand);
  if (!v.ok) return { ok: false, text: `⚠ ${v.error}` };
  const cwd = typeof rawCwd === "string" && rawCwd.trim() ? rawCwd.trim() : cfg.cwd;

  const approved = await requireApproval(v.command, cwd);
  if (!approved) {
    audit({ command: v.command, cwd, decision: "denied" });
    return { ok: true, denied: true, text: "Jordan denied it (or didn't answer in time) — the command did not run." };
  }

  const result = await execCommand(v.command, { cwd, timeoutMs: cfg.timeoutMs, maxOutputChars: cfg.maxOutputChars });
  audit({
    command: v.command,
    cwd,
    decision: "approved",
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    error: result.error ?? null,
  });
  return { ok: true, denied: false, text: formatResult(result), exitCode: result.exitCode ?? null };
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
  id: "butler-shell",
  name: "Butler Shell",
  description: "Run any command on this computer — every command requires explicit phone approval before it executes.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    // The agent tool. Note: approval is requested INSIDE execute (structural),
    // so don't also list run_command in butler-approvals sensitiveTools — that
    // would double-prompt.
    if (typeof api.registerTool === "function") {
      api.registerTool({
        name: "run_command",
        description:
          "Run a PowerShell command on the user's computer. EVERY command is sent to the user's phone " +
          "for approval first and only executes if they approve — so propose exactly what's needed and " +
          "keep commands short, non-interactive, and single-purpose. Returns exit code and output. " +
          "Use the specialised tools (pc_action, set_reminder, remember) when they fit; this is for " +
          "everything they can't do.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The exact PowerShell command to run." },
            cwd: { type: "string", description: "Working directory (optional; defaults to the user's home)." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const { text } = await gatedRun(params?.command, params?.cwd);
          return { content: [{ type: "text", text }] };
        },
      });
    }

    // Deterministic surface for the app (and testing). Same gate — the phone
    // card appears no matter who asks. POST /api/v1/shell {command, cwd?}
    api.registerHttpRoute({
      path: "/api/v1/shell",
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
        const r = await gatedRun(body.command, body.cwd);
        return send(200, r);
      },
    });
  },
};
