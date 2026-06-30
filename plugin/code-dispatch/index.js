import { execFile } from "node:child_process";
import { writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const WORKSPACE = join(homedir(), ".openclaw", "workspace");
const SCRIPTS_DIR = join(WORKSPACE, "scripts");
const JOBS_DIR = join(WORKSPACE, "jobs");
const HOLD_FILE = join(WORKSPACE, "keepawake-hold.json");
const STATE_FILE = join(WORKSPACE, "keepawake-state.json");
const AUDIT_FILE = join(WORKSPACE, "dispatch-audit.log");

// Terminal job states (a runner is no longer expected to be working).
const TERMINAL = ["done", "failed", "canceled", "interrupted"];

// Append-only audit trail for code-executing / state-changing actions.
// This endpoint can run arbitrary code on the host, so every build/cancel is logged.
function appendAudit(entry) {
  try {
    const e = { ts: new Date().toISOString(), ...entry };
    if (typeof e.task === "string" && e.task.length > 200) e.task = e.task.slice(0, 200) + "…";
    appendFileSync(AUDIT_FILE, JSON.stringify(e) + "\n", "utf8");
  } catch {}
}

// process.kill(pid, 0) probes existence without signalling. EPERM means the
// process exists but is owned by someone else — still "alive" for our purposes.
function isPidAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// On startup, any job still marked "running" whose runner process is gone was
// orphaned by a crash/reboot. Flip it to "interrupted" so it doesn't hang forever.
function reconcileJobs() {
  if (!existsSync(JOBS_DIR)) return;
  for (const f of readdirSync(JOBS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const file = join(JOBS_DIR, f);
    const m = readJson(file);
    if (!m || m.status !== "running") continue;
    if (isPidAlive(m.runnerPid)) continue; // genuinely still building
    m.status = "interrupted";
    m.finished = new Date().toISOString();
    try {
      writeFileSync(file, JSON.stringify(m, null, 2), "utf8");
    } catch {}
  }
}

function removeJobArtifacts(id) {
  const safe = String(id).replace(/[^0-9A-Za-z_-]/g, "");
  if (!safe) return;
  for (const ext of [".json", ".log", ".task.txt", ".runner.ps1", ".notify.log"]) {
    try {
      rmSync(join(JOBS_DIR, safe + ext), { force: true });
    } catch {}
  }
}

// Keep the jobs dir from growing forever: drop finished jobs older than
// maxAgeDays, and anything beyond the newest keepLast. Never touch running jobs.
function pruneJobs({ maxAgeDays = 14, keepLast = 200 } = {}) {
  if (!existsSync(JOBS_DIR)) return;
  const metas = readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ id: f.slice(0, -5), meta: readJson(join(JOBS_DIR, f)) }))
    .filter((x) => x.meta && x.meta.id);
  // ids are yyyyMMdd-HHmmss, so lexicographic sort == chronological. Newest first.
  metas.sort((a, b) => (a.id < b.id ? 1 : -1));
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  metas.forEach((x, i) => {
    if (x.meta.status === "running") return;
    const t = Date.parse(x.meta.finished ?? x.meta.started ?? "");
    const tooOld = Number.isFinite(t) && t < cutoff;
    if (tooOld || i >= keepLast) removeJobArtifacts(x.id);
  });
}

function readJson(file) {
  try {
    // PowerShell's Set-Content -Encoding utf8 writes a UTF-8 BOM; strip it.
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Structured job list (newest first) for the app's Jobs screen.
function listJobsData(limit = 30) {
  if (!existsSync(JOBS_DIR)) return [];
  const files = readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit);
  const jobs = [];
  for (const f of files) {
    const m = readJson(join(JOBS_DIR, f));
    if (!m || !m.id) continue;
    jobs.push({
      id: m.id,
      project: m.project ? basename(m.project) : "?",
      task: m.task ?? "",
      status: m.status ?? "unknown",
      started: m.started ?? null,
      finished: m.finished ?? null,
      // Optional extras (older clients ignore unknown fields).
      exitCode: typeof m.exitCode === "number" ? m.exitCode : null,
      result: m.result ?? null,
    });
  }
  return jobs;
}

function briefInput(input) {
  if (!input || typeof input !== "object") return "";
  const v =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.prompt ?? input.url ?? "";
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

// Turn Claude Code's stream-json (one JSON event per line) into a readable
// timeline. Falls back to raw text for old plain-text logs.
function formatClaudeStream(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const raw = [];
  let sawEvent = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      raw.push(t);
      continue;
    }
    if (!ev || typeof ev !== "object" || !ev.type) continue;
    sawEvent = true;
    if (ev.type === "system" && ev.subtype === "init") {
      out.push(`▶ session started${ev.model ? ` · ${ev.model}` : ""}`);
    } else if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "text" && b.text && b.text.trim()) out.push(`💬 ${b.text.trim()}`);
        else if (b.type === "tool_use") {
          const arg = briefInput(b.input);
          out.push(`🔧 ${b.name}${arg ? ` · ${arg}` : ""}`);
        }
      }
    } else if (ev.type === "result") {
      const dur = ev.duration_ms ? ` · ${Math.round(ev.duration_ms / 1000)}s` : "";
      const cost = typeof ev.total_cost_usd === "number" ? ` · $${ev.total_cost_usd.toFixed(2)}` : "";
      out.push(`${ev.is_error ? "✗ error" : "✓ done"}${dur}${cost}`);
      if (ev.result && typeof ev.result === "string" && ev.result.trim()) out.push(ev.result.trim());
    }
  }
  if (!sawEvent) return text; // old-style plain log
  let result = out.join("\n\n");
  if (raw.length) result += `\n\n— output —\n${raw.join("\n")}`;
  return result;
}

function jobLogTail(jobId, maxChars = 8000) {
  const safe = String(jobId ?? "").replace(/[^0-9A-Za-z_-]/g, "");
  if (!safe) return "";
  const log = join(JOBS_DIR, `${safe}.log`);
  try {
    // PowerShell's `*>` redirection writes UTF-16 LE; other writers use UTF-8.
    const buf = readFileSync(log);
    let text;
    if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le");
    else if (buf[0] === 0xfe && buf[1] === 0xff) text = buf.swap16().toString("utf16le");
    else text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const formatted = formatClaudeStream(text);
    return formatted.length > maxChars ? "…" + formatted.slice(formatted.length - maxChars) : formatted || "(no output yet)";
  } catch {
    return "(no log yet)";
  }
}

// Live keep-awake + active-work status for the app's dashboard.
function awakeStatus() {
  const state = readJson(STATE_FILE) ?? {};
  const running = listJobsData(50).filter((j) => j.status === "running");
  return {
    blockingSleep: Boolean(state.blockingSleep),
    active: Boolean(state.active),
    holdUntil: state.holdUntil ?? null,
    checkedAt: state.checkedAt ?? null,
    runningJobs: running.length,
  };
}

// Parse a duration like "2h", "90m", "45s", "1h30m" into milliseconds.
function parseDurationMs(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  const re = /(\d+)\s*(h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    total += m[2] === "h" ? n * 3600_000 : m[2] === "m" ? n * 60_000 : n * 1000;
  }
  if (!matched) {
    const bare = parseInt(s, 10); // bare number = minutes
    if (!Number.isNaN(bare)) return bare * 60_000;
    return null;
  }
  return total;
}

// "/awake <duration|off>" — write or clear the keep-awake hold the
// openclaw-awake.ps1 watcher honors. Keeps the PC from sleeping on demand.
function setAwakeHold(arg) {
  const a = String(arg ?? "").trim().toLowerCase();
  if (a === "off" || a === "stop" || a === "0") {
    try { rmSync(HOLD_FILE, { force: true }); } catch {}
    return "Keep-awake hold cleared. Normal sleep settings apply (2h idle).";
  }
  const ms = parseDurationMs(a || "2h");
  if (!ms || ms < 60_000) {
    return "Usage: /awake <duration>  e.g. /awake 2h, /awake 90m, /awake off";
  }
  const until = new Date(Date.now() + ms);
  try {
    writeFileSync(HOLD_FILE, JSON.stringify({ until: until.toISOString(), setAt: new Date().toISOString() }), "utf8");
  } catch (e) {
    return `Couldn't set hold: ${e.message}`;
  }
  return `Holding the computer awake until ${until.toLocaleString()} (it won't sleep until then). /awake off to release.`;
}

function runScript(file, args) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(SCRIPTS_DIR, file), ...args],
      { timeout: 120_000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (err && !out) resolve(`Error: ${err.message}`);
        else resolve(out || "(no output)");
      },
    );
  });
}

function parseBuildArgs(raw) {
  let continueSession = false;
  let rest = (raw ?? "").trim();
  if (/(^|\s)--continue(\s|$)/.test(rest)) {
    continueSession = true;
    rest = rest.replace(/(^|\s)--continue(\s|$)/, " ").trim();
  }
  const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
  if (!match) return null;
  return { project: match[1], task: match[2], continueSession };
}

async function runBuild({ project, task, continueSession }) {
  const args = ["-Project", project, "-Task", task];
  if (continueSession) args.push("-Continue");
  return runScript("dispatch-claude.ps1", args);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Named exports for unit testing the pure helpers (see index.test.js).
export { formatClaudeStream, parseDurationMs, parseBuildArgs, briefInput };

export default {
  id: "code-dispatch",
  name: "Code Dispatch",
  description:
    "Deterministic /build and /jobs chat commands that dispatch coding tasks to Claude Code on this machine.",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    // Startup housekeeping: heal jobs orphaned by a crash/reboot, then prune old artifacts.
    try {
      reconcileJobs();
      pruneJobs();
    } catch {}

    // Agent-callable build tool. This is what makes building conversational: when
    // Jordan describes something to build in chat, the model calls this and the
    // butler-approvals gate turns it into a "confirm on your phone" card before
    // anything runs (build_project is listed in that plugin's sensitiveTools).
    if (typeof api.registerTool === "function") {
      api.registerTool({
        name: "build_project",
        description:
          "Dispatch a coding task to Claude Code running on Jordan's PC. Use this whenever Jordan asks " +
          "you to build, make, create, code, implement, or set up any software — an app, script, website, " +
          "game, CLI tool, or automation (e.g. 'build me a snake game', 'make a script that renames files', " +
          "'create a landing page for…'). Don't explain how he could do it himself and don't interrogate " +
          "him with lots of questions first — once the request is clear enough to start, call this. If he " +
          "didn't name the project, pick a short kebab-case name from what he described. Jordan gets a " +
          "confirmation prompt before any code runs, so it's safe to call as soon as intent is clear.",
        parameters: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "Short kebab-case project/folder name, e.g. 'snake-game'. Infer one if not given.",
            },
            task: {
              type: "string",
              description: "What to build, in plain English — include all the detail Jordan provided.",
            },
            continueSession: {
              type: "boolean",
              description: "True to resume this project's previous Claude Code session instead of starting fresh.",
            },
          },
          required: ["project", "task"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const project = String(params?.project ?? "").trim();
          const task = String(params?.task ?? "").trim();
          if (!project || !task) {
            return { content: [{ type: "text", text: "I need both a project name and a description of what to build." }] };
          }
          appendAudit({ action: "build", source: "tool", project, task });
          const text = await runBuild({ project, task, continueSession: Boolean(params?.continueSession) });
          return { content: [{ type: "text", text }] };
        },
      });
    }

    // Build-request protocol. Clawdia is local-first and free: she can build small
    // things herself with her own tools. Claude Code (installed on the PC) is an
    // OPTIONAL stronger coder Jordan can opt into. Rather than rely on the local
    // model to call a tool (unreliable), she emits a tiny text MARKER the app turns
    // into a "Use Claude" confirm card — text generation the 20B model handles well.
    if (typeof api.on === "function") {
      api.on("before_prompt_build", async () => ({
        prependSystemContext:
          "# Building software\n" +
          "You are local-first and free: you can build small things yourself using your own tools. " +
          "Claude Code — a much stronger coding agent — is also installed on Jordan's PC, and he can " +
          "OPT IN to it for bigger or higher-quality builds.\n\n" +
          "When Jordan asks you to build, make, create, code, or set up any software (an app, game, " +
          "website, script, tool, or automation):\n" +
          "1. Reply briefly in your normal voice — acknowledge what he wants and offer the choice: you " +
          "can build it yourself, or hand it to Claude for a stronger version.\n" +
          "2. On the VERY LAST line, output a build marker in EXACTLY this format, with nothing after it:\n" +
          "   [[BUILD: project=<short-kebab-name> | task=<one concise sentence of what to build>]]\n" +
          "   Pick a sensible kebab-case project name from his request. This marker is not visible prose " +
          "— it becomes a tap-to-build button in the app, so don't mention or describe it.\n" +
          "Do NOT create the files yourself unless Jordan explicitly tells you to do it yourself / locally.",
      }));
    }

    // HTTP entry point for the Butler phone app (gateway token auth).
    // POST /api/v1/code-dispatch  {"action":"build","project":"x","task":"...","continue":false}
    //                             {"action":"jobs","jobId":"optional"}
    //                             {"action":"cancel","jobId":"..."}
    // GET  /api/v1/code-dispatch/stream?jobId=...  (SSE live log)
    api.registerHttpRoute({
      path: "/api/v1/code-dispatch",
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
        if (body.action === "build") {
          if (!body.project || !body.task) return send(400, { error: "Need project and task" });
          appendAudit({ action: "build", source: "http", project: String(body.project), task: String(body.task) });
          const text = await runBuild({
            project: String(body.project),
            task: String(body.task),
            continueSession: Boolean(body.continue),
          });
          return send(200, { text });
        }
        if (body.action === "cancel") {
          if (!body.jobId) return send(400, { error: "Need jobId" });
          appendAudit({ action: "cancel", source: "http", jobId: String(body.jobId) });
          const text = await runScript("cancel-claude.ps1", ["-JobId", String(body.jobId)]);
          return send(200, { text });
        }
        if (body.action === "jobs") {
          const text = await runScript(
            "check-claude.ps1",
            body.jobId ? ["-JobId", String(body.jobId)] : [],
          );
          return send(200, { text });
        }
        if (body.action === "jobsData") {
          return send(200, { jobs: listJobsData(typeof body.limit === "number" ? body.limit : 30) });
        }
        if (body.action === "jobLog") {
          if (!body.jobId) return send(400, { error: "Need jobId" });
          return send(200, { log: jobLogTail(body.jobId) });
        }
        if (body.action === "awake") {
          return send(200, { text: setAwakeHold(body.duration), status: awakeStatus() });
        }
        if (body.action === "status") {
          return send(200, { status: awakeStatus() });
        }
        return send(400, { error: "Unknown action" });
      },
    });

    // Live job-log stream (Server-Sent Events). Clients open this while a job is
    // running for true live progress instead of 3s polling; each event carries a
    // full formatted snapshot, and a final `event: end` carries the result.
    api.registerHttpRoute({
      path: "/api/v1/code-dispatch/stream",
      auth: "gateway",
      match: "exact",
      handler: (req, res) => {
        const jobId = String(new URL(req.url, "http://localhost").searchParams.get("jobId") ?? "")
          .replace(/[^0-9A-Za-z_-]/g, "");
        if (!jobId) {
          res.statusCode = 400;
          res.end("Need jobId");
          return true;
        }
        const metaFile = join(JOBS_DIR, `${jobId}.json`);
        if (!existsSync(metaFile)) {
          res.statusCode = 404;
          res.end("No such job");
          return true;
        }
        const logFile = join(JOBS_DIR, `${jobId}.log`);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        let lastSize = -1;
        let lastBeat = Date.now();
        let tick;
        const cleanup = () => {
          if (tick) clearInterval(tick);
          tick = null;
        };
        const sendSnapshot = () => {
          res.write(`data: ${JSON.stringify({ log: jobLogTail(jobId, 100_000) })}\n\n`);
        };

        sendSnapshot();
        try { lastSize = statSync(logFile).size; } catch {}

        tick = setInterval(() => {
          let size = -1;
          try { size = statSync(logFile).size; } catch {}
          if (size !== lastSize) {
            lastSize = size;
            lastBeat = Date.now();
            sendSnapshot();
          }
          const m = readJson(metaFile);
          if (m && TERMINAL.includes(m.status)) {
            res.write(`event: end\ndata: ${JSON.stringify({ status: m.status, result: m.result ?? null, exitCode: m.exitCode ?? null })}\n\n`);
            cleanup();
            res.end();
            return;
          }
          if (Date.now() - lastBeat > 20_000) {
            lastBeat = Date.now();
            res.write(`: keepalive\n\n`);
          }
        }, 1000);

        req.on("close", cleanup);
        return true;
      },
    });

    api.registerCommand({
      name: "build",
      description:
        "Dispatch a coding task to Claude Code: /build <project> <task…>  (add --continue to resume that project's previous session)",
      acceptsArgs: true,
      handler: async (ctx) => {
        const raw = (ctx.args ?? "").trim();
        if (!raw) {
          return {
            text: "Usage: /build <project> <task…>\nAdd --continue to resume the project's previous Claude Code session.",
          };
        }
        const parsed = parseBuildArgs(raw);
        if (!parsed) {
          return { text: "Need a project AND a task. Usage: /build <project> <task…>" };
        }
        appendAudit({ action: "build", source: "command", project: parsed.project, task: parsed.task });
        return { text: await runBuild(parsed) };
      },
    });

    api.registerCommand({
      name: "cancel",
      description: "Cancel a running Claude Code job: /cancel <id>",
      acceptsArgs: true,
      handler: async (ctx) => {
        const id = (ctx.args ?? "").trim();
        if (!id) return { text: "Usage: /cancel <jobId>" };
        appendAudit({ action: "cancel", source: "command", jobId: id });
        return { text: await runScript("cancel-claude.ps1", ["-JobId", id]) };
      },
    });

    api.registerCommand({
      name: "jobs",
      description: "List Claude Code jobs, or show one with its log: /jobs [id]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const id = (ctx.args ?? "").trim();
        return { text: await runScript("check-claude.ps1", id ? ["-JobId", id] : []) };
      },
    });

    api.registerCommand({
      name: "awake",
      description: "Keep the computer from sleeping on demand: /awake <duration> (e.g. 2h, 90m) or /awake off",
      acceptsArgs: true,
      handler: async (ctx) => ({ text: setAwakeHold(ctx.args) }),
    });
  },
};
