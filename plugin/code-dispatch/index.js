import { execFile } from "node:child_process";
import { createReadStream, writeFileSync, appendFileSync, rmSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const WORKSPACE = join(homedir(), ".openclaw", "workspace");
const SCRIPTS_DIR = join(WORKSPACE, "scripts");
const JOBS_DIR = join(WORKSPACE, "jobs");
const HOLD_FILE = join(WORKSPACE, "keepawake-hold.json");
const STATE_FILE = join(WORKSPACE, "keepawake-state.json");
const AUDIT_FILE = join(WORKSPACE, "dispatch-audit.log");
const CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");

// Terminal job states (a runner is no longer expected to be working).
const TERMINAL = ["done", "failed", "canceled", "interrupted"];

// How long to let the butler compose its own account of a finished build before
// falling back to a deterministic one-liner.
const REPORT_TIMEOUT_MS = 90_000;
// A push body longer than this is truncated by Android anyway.
const MAX_PUSH_CHARS = 900;
// Safety net: how often to look for terminal jobs that never got reported
// (runner killed, gateway restarted mid-finish, POST lost).
const SWEEP_MS = 30_000;
// Directories that never hold build output but cost a lot to walk.
const SKIP_DIRS = new Set(["node_modules", ".git", ".gradle", ".expo", "vendor", "Pods", "dist", ".next"]);

let sweepTimer = null;
// Jobs currently being finalized, so the sweep and the runner's POST can't both
// generate a report for the same job.
const finalizing = new Set();

// The owner's name from the app's Persona editor (persona.json `owner`), with
// a generic fallback — tool descriptions and nudges read better with a name.
function ownerRef() {
  try {
    let t = readFileSync(join(WORKSPACE, "persona.json"), "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    const o = JSON.parse(t)?.owner;
    if (typeof o === "string" && o.trim()) return o.trim();
  } catch {}
  return "the user";
}

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
      // What the build left behind and what the butler said about it. `artifact`
      // drops the on-disk path — the app downloads by job id, never by path.
      artifact: m.artifact ? { type: m.artifact.type, name: m.artifact.name, size: m.artifact.size } : null,
      files: m.files ?? null,
      report: m.report ?? null,
      reported: Boolean(m.reported),
      // Live progress, only for jobs still working (parsing the log costs a read).
      progress: m.status === "running" ? jobProgress(m.id) : null,
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

// Read a job log as text, whatever encoding the runner happened to write it in.
// PowerShell's `*>` redirection writes UTF-16 LE; other writers use UTF-8.
function readLogText(jobId) {
  const safe = String(jobId ?? "").replace(/[^0-9A-Za-z_-]/g, "");
  if (!safe) return null;
  let buf;
  try {
    buf = readFileSync(join(JOBS_DIR, `${safe}.log`));
  } catch {
    return null;
  }
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString("utf16le");
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = buf.swap16().toString("utf16le");
  else text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

// Pull the final `result` event out of a stream-json log. Done here rather than
// in the runner because PowerShell 5.1's Get-Content reads BOM-less UTF-8 as
// ANSI — every summary came back with em-dashes and arrows as mojibake.
export function resultFrom(text) {
  let last = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    // Cheap pre-filter, then decide on the parsed shape — matching the exact
    // string '"type":"result"' would miss any writer that pretty-prints.
    if (!t || t[0] !== "{" || !t.includes("result")) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type === "result") last = ev;
  }
  if (!last) return null;
  let summary = typeof last.result === "string" ? last.result.trim() : "";
  if (summary.length > 500) summary = summary.slice(0, 500) + "…";
  return {
    durationMs: typeof last.duration_ms === "number" ? last.duration_ms : null,
    costUsd: typeof last.total_cost_usd === "number" ? last.total_cost_usd : null,
    isError: Boolean(last.is_error),
    summary,
  };
}

function jobLogTail(jobId, maxChars = 8000) {
  const text = readLogText(jobId);
  if (text === null) return "(no log yet)";
  const formatted = formatClaudeStream(text);
  return formatted.length > maxChars ? "…" + formatted.slice(formatted.length - maxChars) : formatted || "(no output yet)";
}

// ---- build artifacts ---------------------------------------------------------

// Find the newest .apk under a project that this job could have produced.
// Bounded walk: build outputs live shallow (android/app/build/outputs/apk/…),
// so a depth cap covers every layout without wandering into dependency trees.
function findApk(dir, sinceMs, depth = 0, best = null) {
  if (depth > 8) return best;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return best;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      best = findApk(join(dir, e.name), sinceMs, depth + 1, best);
      continue;
    }
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".apk")) continue;
    const full = join(dir, e.name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    // Only count APKs this job actually touched. An older one sitting in the
    // repo isn't "what Claude just built" — 1s of slack for clock jitter.
    if (st.mtimeMs + 1000 < sinceMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { path: full, name: e.name, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

// The one thing a finished build can hand straight to a phone. Non-Android
// projects return null and the report falls back to a summary + file list.
function artifactFor(meta) {
  const proj = meta?.project;
  if (!proj || !existsSync(proj)) return null;
  const since = Date.parse(meta.started ?? "") || 0;
  const apk = findApk(proj, since);
  if (!apk) return null;
  return {
    type: "apk",
    name: apk.name,
    path: apk.path,
    size: apk.size,
    builtAt: new Date(apk.mtimeMs).toISOString(),
  };
}

// What the build actually changed on disk — the useful answer to "so what did
// it do?" for every project that can't produce an installable.
function changedFiles(proj) {
  return new Promise((resolve) => {
    if (!proj || !existsSync(proj)) return resolve([]);
    execFile(
      "git",
      ["-C", proj, "status", "--porcelain"],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        const files = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => l.replace(/^\S+\s+/, "").replace(/^"|"$/g, ""));
        resolve(files.slice(0, 40));
      },
    );
  });
}

// ---- reporting ---------------------------------------------------------------

function gatewayAuth() {
  const cfg = readJson(CONFIG_FILE) ?? {};
  return { token: cfg?.gateway?.auth?.token ?? "", port: cfg?.gateway?.port ?? 18789 };
}

function humanSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  const mb = bytes / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The deterministic account, used verbatim when the model is unreachable and as
// the seed for the model's own version.
export function fallbackReport(meta, artifact, files) {
  const name = basename(meta?.project ?? "project");
  const ok = meta?.status === "done";
  const head = ok ? `Build finished: ${name}.` : `Build ${meta?.status ?? "ended"}: ${name}.`;
  const bits = [head];
  const summary = String(meta?.result?.summary ?? "").trim();
  if (summary) bits.push(summary.split(/\n\s*\n/)[0].slice(0, 300));
  if (artifact) bits.push(`APK ready to install: ${artifact.name} (${humanSize(artifact.size)}).`);
  else if (files?.length) bits.push(`${files.length} file${files.length === 1 ? "" : "s"} changed.`);
  return bits.join(" ");
}

// Ask the butler to describe the finished build in its own voice. This is the
// piece that used to be missing entirely: the runner fired a bare deterministic
// push, so the model never learned a build had happened and never mentioned it.
async function generateReport(meta, artifact, files) {
  const { token, port } = gatewayAuth();
  if (!token) return null;
  const name = basename(meta?.project ?? "project");
  const facts = [
    `Project: ${name}`,
    `Task: ${meta?.task ?? "(none recorded)"}`,
    `Outcome: ${meta?.status}${typeof meta?.exitCode === "number" ? ` (exit code ${meta.exitCode})` : ""}`,
  ];
  if (meta?.result?.durationMs) facts.push(`Took: ${Math.round(meta.result.durationMs / 1000)}s`);
  if (meta?.result?.summary) facts.push(`Claude's own summary:\n${meta.result.summary}`);
  if (artifact) facts.push(`Installable APK produced: ${artifact.name} (${humanSize(artifact.size)}) — they can install it straight from the app.`);
  else if (files?.length) facts.push(`Files changed (${files.length}): ${files.slice(0, 15).join(", ")}`);

  const prompt =
    "SYSTEM EVENT — not a message from your owner. A coding job you handed to Claude Code on the PC " +
    "just finished. Tell your owner about it now, unprompted, in your own voice.\n\n" +
    facts.join("\n") +
    "\n\nWrite 2-4 short sentences: what got built, whether it worked, and what they can do next " +
    (artifact ? "(mention they can install the APK from the app). " : "(where the code lives). ") +
    "Plain text, no markdown, no headings, under 90 words. Do not mention this system event.";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: "openclaw",
        // Fresh session per report: the job facts are all the context needed,
        // and nothing accumulates into the local model's window.
        user: `build-report-${meta?.id}-${Date.now().toString(36)}`,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const reply = body?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) return null;
    return reply.trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Push to the phone through butler-approvals' generic notify action — the same
// route reminders and heartbeats use. `data` carries the job id so tapping the
// notification can open straight to that build.
async function sendNotify(title, body, data) {
  const { token, port } = gatewayAuth();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "notify",
        title,
        body: body.length > MAX_PUSH_CHARS ? body.slice(0, MAX_PUSH_CHARS - 1) + "…" : body,
        channel: "reminders",
        data,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Everything that should happen the moment a build lands: find the artifact,
// list what changed, have the butler say something human about it, push it, and
// record it all on the job so the app and the next chat turn can both see it.
async function finalizeJob(jobId) {
  const safe = String(jobId ?? "").replace(/[^0-9A-Za-z_-]/g, "");
  if (!safe || finalizing.has(safe)) return null;
  const file = join(JOBS_DIR, `${safe}.json`);
  const meta = readJson(file);
  if (!meta || !TERMINAL.includes(meta.status) || meta.reported) return null;
  finalizing.add(safe);
  try {
    // Re-derive the summary from the log ourselves. The runner also writes one,
    // but it goes through PowerShell's lossy text handling; this copy is clean.
    const parsed = resultFrom(readLogText(safe));
    if (parsed) meta.result = parsed;
    const artifact = artifactFor(meta);
    const files = await changedFiles(meta.project);
    const report = (await generateReport(meta, artifact, files)) ?? fallbackReport(meta, artifact, files);
    const title = `Build ${meta.status}: ${basename(meta.project ?? "project")}`;
    const pushed = await sendNotify(title, report, {
      type: "build",
      jobId: safe,
      status: String(meta.status),
      artifact: artifact ? "apk" : "",
    });
    // Re-read: the job file may have been rewritten while the model was thinking.
    const fresh = readJson(file) ?? meta;
    if (parsed) fresh.result = parsed;
    fresh.artifact = artifact;
    fresh.files = files;
    fresh.report = report;
    fresh.reported = true;
    fresh.reportedAt = new Date().toISOString();
    fresh.pushed = pushed;
    try {
      writeFileSync(file, JSON.stringify(fresh, null, 2), "utf8");
    } catch {}
    appendAudit({ action: "build.reported", jobId: safe, status: fresh.status, artifact: artifact?.name ?? null, pushed });
    return fresh;
  } finally {
    finalizing.delete(safe);
  }
}

// Catch jobs that reached a terminal state without being reported — a killed
// runner, a gateway restart mid-finish, or a lost POST. Cheap: only reads the
// job metadata, and only acts on the unreported ones.
async function sweepUnreported() {
  if (!existsSync(JOBS_DIR)) return;
  let names;
  try {
    names = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of names.sort().reverse().slice(0, 20)) {
    const meta = readJson(join(JOBS_DIR, f));
    if (!meta || meta.reported || !TERMINAL.includes(meta.status)) continue;
    try {
      await finalizeJob(meta.id);
    } catch {}
  }
}

// A one-line "what is it doing right now" digest for a running job, so the app
// can show live progress without pulling the whole log on every poll.
export function progressFrom(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let tools = 0;
  let last = "";
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type !== "assistant") continue;
    for (const b of ev.message?.content ?? []) {
      if (b.type === "tool_use") {
        tools += 1;
        const arg = briefInput(b.input);
        last = `${b.name}${arg ? ` · ${arg}` : ""}`;
      } else if (b.type === "text" && b.text?.trim()) {
        last = b.text.trim().split("\n")[0].slice(0, 100);
      }
    }
  }
  return { tools, last };
}

function jobProgress(jobId) {
  return progressFrom(readLogText(jobId) ?? "");
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
export { formatClaudeStream, parseDurationMs, parseBuildArgs, briefInput, humanSize };

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

    // Safety net for the report path: any build that reached a terminal state
    // without being reported gets picked up here, including ones that finished
    // while the gateway was down.
    if (!sweepTimer) {
      sweepTimer = setInterval(() => sweepUnreported().catch(() => {}), SWEEP_MS);
      if (typeof sweepTimer.unref === "function") sweepTimer.unref();
    }

    // Agent-callable build tool. This is what makes building conversational: when
    // the owner describes something to build in chat, the model calls this and the
    // butler-approvals gate turns it into a "confirm on your phone" card before
    // anything runs (build_project is listed in that plugin's sensitiveTools).
    if (typeof api.registerTool === "function") {
      const who = ownerRef();
      api.registerTool({
        name: "build_project",
        description:
          `Dispatch a coding task to Claude Code running on ${who}'s PC. Use this whenever ${who} asks ` +
          "you to build, make, create, code, implement, or set up any software — an app, script, website, " +
          "game, CLI tool, or automation (e.g. 'build me a snake game', 'make a script that renames files', " +
          "'create a landing page for…'). Don't explain how they could do it themselves and don't interrogate " +
          "them with lots of questions first — once the request is clear enough to start, call this. If they " +
          `didn't name the project, pick a short kebab-case name from what they described. ${who} gets a ` +
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
              description: "What to build, in plain English — include all the detail the user provided.",
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

    // Build-request protocol. The butler is local-first and free: it can build
    // small things itself with its own tools. Claude Code (installed on the PC)
    // is an OPTIONAL stronger coder the owner can opt into. Rather than rely on
    // the local model to call a tool (unreliable), it emits a tiny text MARKER
    // the app turns into a "Use Claude" confirm card — text generation the 20B
    // model handles well.
    if (typeof api.on === "function") {
      api.on("before_prompt_build", async () => {
        const who = ownerRef();
        return {
          prependSystemContext:
            "# Building software\n" +
            "You are local-first and free: you can build small things yourself using your own tools. " +
            `Claude Code — a much stronger coding agent — is also installed on ${who}'s PC, and they can ` +
            "OPT IN to it for bigger or higher-quality builds.\n\n" +
            `When ${who} asks you to build, make, create, code, or set up any software (an app, game, ` +
            "website, script, tool, or automation):\n" +
            "1. Reply briefly in your normal voice — acknowledge what they want and offer the choice: you " +
            "can build it yourself, or hand it to Claude for a stronger version.\n" +
            "2. On the VERY LAST line, output a build marker in EXACTLY this format, with nothing after it:\n" +
            "   [[BUILD: project=<short-kebab-name> | task=<one concise sentence of what to build>]]\n" +
            "   Pick a sensible kebab-case project name from the request. This marker is not visible prose " +
            "— it becomes a tap-to-build button in the app, so don't mention or describe it.\n" +
            `Do NOT create the files yourself unless ${who} explicitly tells you to do it yourself / locally.`,
        };
      });
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
        // Fired by the job runner the instant a build lands. Kicks off artifact
        // detection + the butler's spoken report. The sweep covers a lost POST,
        // so this is about latency, not correctness.
        if (body.action === "jobFinished") {
          if (!body.jobId) return send(400, { error: "Need jobId" });
          const meta = await finalizeJob(body.jobId);
          return send(200, { ok: true, report: meta?.report ?? null, artifact: meta?.artifact ?? null });
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

    // Artifact download. The one route that answers "give me the thing you just
    // built" — the app fetches it with the gateway token and hands it to
    // Android's installer. Served by job id, never by caller-supplied path, so
    // this can't be walked into an arbitrary file read.
    api.registerHttpRoute({
      path: "/api/v1/code-dispatch/artifact",
      auth: "gateway",
      match: "exact",
      handler: (req, res) => {
        const jobId = String(new URL(req.url, "http://localhost").searchParams.get("jobId") ?? "")
          .replace(/[^0-9A-Za-z_-]/g, "");
        const meta = jobId ? readJson(join(JOBS_DIR, `${jobId}.json`)) : null;
        const art = meta?.artifact;
        if (!art?.path || !existsSync(art.path)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "No artifact for this job" }));
          return true;
        }
        let size = art.size;
        try {
          size = statSync(art.path).size;
        } catch {}
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/vnd.android.package-archive");
        res.setHeader("Content-Length", String(size));
        res.setHeader("Content-Disposition", `attachment; filename="${art.name.replace(/[^\w.-]/g, "_")}"`);
        const stream = createReadStream(art.path);
        stream.on("error", () => res.end());
        stream.pipe(res);
        return true;
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
        // Set once the job goes terminal: the stream then stays open a little
        // longer waiting for the butler's report, so a client watching live gets
        // the spoken result in the same stream instead of a silent cutoff.
        let terminalAt = 0;
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
            if (!terminalAt) {
              terminalAt = Date.now();
              // Nothing else may have noticed yet if the runner's POST was lost.
              finalizeJob(jobId).catch(() => {});
            }
            // Hold briefly for the report; don't strand the client if it never
            // lands. Comment frames only every 20s — this can wait ~100s and a
            // per-tick comment would be a hundred pointless writes.
            if (!m.reported && Date.now() - terminalAt < REPORT_TIMEOUT_MS + 10_000) {
              if (Date.now() - lastBeat > 20_000) {
                lastBeat = Date.now();
                res.write(`: awaiting-report\n\n`);
              }
              return;
            }
            res.write(
              `event: end\ndata: ${JSON.stringify({
                status: m.status,
                result: m.result ?? null,
                exitCode: m.exitCode ?? null,
                report: m.report ?? null,
                artifact: m.artifact ? { type: m.artifact.type, name: m.artifact.name, size: m.artifact.size } : null,
                files: m.files ?? null,
              })}\n\n`,
            );
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
