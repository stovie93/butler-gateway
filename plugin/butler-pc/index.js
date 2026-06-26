import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler PC quick-actions: a small, allow-listed set of safe/reversible local
// actions (status, disk, battery, processes, lock, open an app, volume) the
// butler can run on this machine — from chat (natural language via the pc_action
// tool, or /pc command) or from the app's PC screen (HTTP route). v1 deliberately
// excludes destructive actions (shutdown/kill); those are a later approval-gated
// follow-on via the butler-approvals relay.

const AUDIT_FILE = join(homedir(), ".openclaw", "workspace", "dispatch-audit.log");
const CONFIG_FILE = join(homedir(), ".openclaw", "openclaw.json");

// Allow-listed launch targets for `open`. Keys are what the user says; values are
// what Start-Process receives. Restricting to a list keeps `open` from running
// arbitrary executables off a remote command.
const OPEN_TARGETS = {
  spotify: "spotify:",
  chrome: "chrome",
  edge: "msedge",
  browser: "msedge",
  explorer: "explorer",
  files: "explorer",
  notepad: "notepad",
  code: "code",
  vscode: "code",
  calc: "calc",
  calculator: "calc",
  settings: "ms-settings:",
  terminal: "wt",
};

// Media-key virtual codes sent via WScript.Shell SendKeys for `volume`.
const VOLUME_KEYS = { mute: 173, down: 174, up: 175 };

function appendAudit(entry) {
  try {
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}

// Run a PowerShell snippet and resolve its trimmed stdout/stderr. Never rejects —
// PC actions are a convenience; a failure returns a readable message.
function runPs(script) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        if (err && !out) resolve(`Error: ${err.message}`);
        else resolve(out || "(no output)");
      },
    );
  });
}

// ---- pure helpers (unit-tested) -------------------------------------------

// Split a "/pc <action> [arg]" string into { action, arg }.
function parsePcArgs(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { action: "", arg: "" };
  const m = s.match(/^(\S+)\s*([\s\S]*)$/);
  return { action: (m[1] ?? "").toLowerCase(), arg: (m[2] ?? "").trim() };
}

// Resolve an `open` argument to an allow-listed target, or null if not allowed.
function resolveOpenTarget(arg) {
  const key = String(arg ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(OPEN_TARGETS, key) ? OPEN_TARGETS[key] : null;
}

// Normalise a volume direction to one of mute/up/down (with a few synonyms).
function resolveVolume(arg) {
  const a = String(arg ?? "").trim().toLowerCase();
  if (["mute", "unmute", "m"].includes(a)) return "mute";
  if (["up", "+", "louder", "raise"].includes(a)) return "up";
  if (["down", "-", "quieter", "lower"].includes(a)) return "down";
  return null;
}

const ACTION_NAMES = ["status", "disk", "battery", "processes", "lock", "open", "volume"];

// ---- actions ---------------------------------------------------------------
// Each returns a short human-readable string. Reads are safe; lock/open/volume
// are benign and reversible. No action here needs an approval.

const ACTIONS = {
  status: async () =>
    runPs(
      "$os=Get-CimInstance Win32_OperatingSystem;" +
        "$cpu=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;" +
        "$tot=[math]::Round($os.TotalVisibleMemorySize/1MB,1);" +
        "$free=[math]::Round($os.FreePhysicalMemory/1MB,1);" +
        "$up=(Get-Date)-$os.LastBootUpTime;" +
        "\"CPU $([int]$cpu)% | RAM $([math]::Round($tot-$free,1))/$tot GB | up $([int]$up.TotalHours)h $($up.Minutes)m\"",
    ),

  disk: async () =>
    runPs(
      "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|ForEach-Object{" +
        "\"$($_.DeviceID) $([math]::Round($_.FreeSpace/1GB,1)) free / $([math]::Round($_.Size/1GB,1)) GB\"" +
        "}) -join \"`n\"",
    ),

  battery: async () =>
    runPs(
      "$b=Get-CimInstance Win32_Battery;" +
        "if($b){\"$($b.EstimatedChargeRemaining)%$(if($b.BatteryStatus -eq 2){' (charging)'})\"}else{'No battery (desktop)'}",
    ),

  processes: async () =>
    runPs(
      "(Get-Process|Sort-Object WS -Descending|Select-Object -First 5|ForEach-Object{" +
        "\"$($_.ProcessName) $([math]::Round($_.WS/1MB))MB\"}) -join \"`n\"",
    ),

  lock: async () => {
    await runPs("rundll32.exe user32.dll,LockWorkStation");
    return "PC locked.";
  },

  open: async (arg) => {
    const target = resolveOpenTarget(arg);
    if (!target) {
      return `Don't know how to open "${arg}". Try: ${Object.keys(OPEN_TARGETS).join(", ")}.`;
    }
    // target comes only from the allow-list above, never raw user input.
    await runPs(`Start-Process '${target}'`);
    return `Opening ${String(arg).trim().toLowerCase()}.`;
  },

  volume: async (arg) => {
    const dir = resolveVolume(arg);
    if (!dir) return "Usage: volume up | down | mute.";
    if (dir === "mute") {
      await runPs(`(New-Object -ComObject WScript.Shell).SendKeys([char]${VOLUME_KEYS.mute})`);
      return "Toggled mute.";
    }
    // Each press is ~2%; send 5 for a noticeable ~10% step.
    const code = VOLUME_KEYS[dir];
    await runPs(`$w=New-Object -ComObject WScript.Shell;1..5|ForEach-Object{$w.SendKeys([char]${code})}`);
    return `Volume ${dir}.`;
  },
};

// Power actions — kept SEPARATE from the safe ACTIONS so they can be gated
// independently (the pc_power tool is sensitive and routes through the approval
// relay). shutdown/restart use a 20s grace window so there's always a chance to
// abort (via /pc abort, the app, or physically at the PC).
const POWER = {
  shutdown: async () => {
    await runPs("shutdown /s /t 20");
    return "Shutting down in 20s. Send '/pc abort' (or tap Abort) to cancel.";
  },
  restart: async () => {
    await runPs("shutdown /r /t 20");
    return "Restarting in 20s. Send '/pc abort' (or tap Abort) to cancel.";
  },
  abort: async () => {
    const out = await runPs("shutdown /a");
    if (/\b1116\b|no shutdown was in progress/i.test(out)) return "No shutdown is scheduled.";
    return "Shutdown/restart aborted.";
  },
};
const POWER_NAMES = ["shutdown", "restart", "abort"];

// All executable actions (safe + power). The tools expose different subsets, but
// the HTTP route and /pc command (user-initiated) can run any of them.
const EXEC = { ...ACTIONS, ...POWER };

// Run one action by name. Returns { ok, text }. Unknown actions are reported.
async function runAction(action, arg) {
  const name = String(action ?? "").trim().toLowerCase();
  if (!EXEC[name]) {
    return { ok: false, text: `Unknown action "${name}". Try: ${[...ACTION_NAMES, ...POWER_NAMES].join(", ")}.` };
  }
  appendAudit({ action: "pc", name, arg: arg ? String(arg).slice(0, 80) : undefined });
  const text = await EXEC[name](arg);
  return { ok: true, text };
}

// Read the gateway's loopback auth so we can call our own approvals endpoint.
function gatewayAuth() {
  try {
    let t = readFileSync(CONFIG_FILE, "utf8");
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // strip UTF-8 BOM
    const cfg = JSON.parse(t);
    return { token: cfg?.gateway?.auth?.token ?? null, port: cfg?.gateway?.port ?? 18789 };
  } catch {
    return { token: null, port: 18789 };
  }
}

// Ask butler-approvals to gate an action (phone card + PC toast), blocking until
// you decide. Returns true only on explicit approval. Fail closed for power.
async function requireApproval(toolName, params) {
  const { token, port } = gatewayAuth();
  if (!token) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "request", toolName, params }),
    });
    const data = await res.json();
    return data?.decision === "allow-once";
  } catch {
    return false;
  }
}

// Used by the user-initiated surfaces (HTTP route, /pc command): power actions
// (except abort) require an approval first; everything else runs directly. The
// agent tool path is NOT routed here — it's already gated by before_tool_call.
async function runMaybeGated(action, arg) {
  const name = String(action ?? "").trim().toLowerCase();
  if (POWER_NAMES.includes(name) && name !== "abort") {
    const approved = await requireApproval("pc_power", { action: name });
    if (!approved) return { ok: true, text: `Denied — not running ${name}.` };
  }
  return runAction(name, arg);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export { parsePcArgs, resolveOpenTarget, resolveVolume, ACTION_NAMES, POWER_NAMES, OPEN_TARGETS };

export default {
  id: "butler-pc",
  name: "Butler PC",
  description: "Run safe, allow-listed quick-actions on this computer (status, disk, lock, open apps, volume).",
  configSchema: { parse: (value) => value ?? {}, safeParse: (value) => ({ success: true, data: value ?? {} }) },
  register(api) {
    // Natural-language entry point: the butler agent calls this when you say
    // things like "lock my PC", "how much disk is free", "open spotify".
    if (typeof api.registerTool === "function") {
      api.registerTool({
        name: "pc_action",
        description:
          "Run a safe quick-action on the user's computer. Actions: " +
          "status (CPU/RAM/uptime), disk (free space), battery, processes (top by memory), " +
          "lock (lock the screen), open (launch an app — arg is the app name like spotify, chrome, explorer, notepad, code, calc, settings, terminal), " +
          "volume (arg is up, down, or mute).",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTION_NAMES, description: "Which quick-action to run." },
            arg: { type: "string", description: "Argument for 'open' (app name) or 'volume' (up/down/mute). Omit otherwise." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const { text } = await runAction(params?.action, params?.arg);
          return { content: [{ type: "text", text }] };
        },
      });

      // Power actions are a SEPARATE tool so they can be gated on their own. Mark
      // this tool name in butler-approvals `sensitiveTools` to require an approval
      // (phone card + PC toast) before the butler can power the machine off.
      api.registerTool({
        name: "pc_power",
        description:
          "Power-control the user's computer. action: 'shutdown' (turn it off), 'restart' (reboot), or " +
          "'abort' (cancel a pending shutdown/restart). Shutdown and restart run after a 20-second grace " +
          "window. This is sensitive — it powers off the machine and cannot be undone remotely.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: POWER_NAMES, description: "shutdown, restart, or abort." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_id, params) {
          const { text } = await runAction(params?.action);
          return { content: [{ type: "text", text }] };
        },
      });
    }

    // Deterministic HTTP entry point for the Butler app's PC screen (gateway auth).
    // POST /api/v1/pc  {"action":"disk"} | {"action":"open","arg":"spotify"}
    api.registerHttpRoute({
      path: "/api/v1/pc",
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
        if (body.action === "actions") {
          return send(200, { actions: ACTION_NAMES, powerActions: POWER_NAMES, openTargets: Object.keys(OPEN_TARGETS) });
        }
        const result = await runMaybeGated(body.action, body.arg);
        if (!result.ok) return send(400, { error: result.text });
        return send(200, { text: result.text });
      },
    });

    // Typed chat command, consistent with /build and /jobs: "/pc <action> [arg]".
    api.registerCommand({
      name: "pc",
      description:
        "Run a PC quick-action: /pc <status|disk|battery|processes|lock|open <app>|volume <up|down|mute>|shutdown|restart|abort>",
      acceptsArgs: true,
      handler: async (ctx) => {
        const { action, arg } = parsePcArgs(ctx.args);
        if (!action) {
          return { text: `Usage: /pc <action>\nActions: ${[...ACTION_NAMES, ...POWER_NAMES].join(", ")}` };
        }
        const { text } = await runMaybeGated(action, arg);
        return { text };
      },
    });
  },
};
