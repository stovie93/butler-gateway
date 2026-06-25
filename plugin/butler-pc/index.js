import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Butler PC quick-actions: a small, allow-listed set of safe/reversible local
// actions (status, disk, battery, processes, lock, open an app, volume) the
// butler can run on this machine — from chat (natural language via the pc_action
// tool, or /pc command) or from the app's PC screen (HTTP route). v1 deliberately
// excludes destructive actions (shutdown/kill); those are a later approval-gated
// follow-on via the butler-approvals relay.

const AUDIT_FILE = join(homedir(), ".openclaw", "workspace", "dispatch-audit.log");

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

// Run one action by name. Returns { ok, text }. Unknown actions are reported.
async function runAction(action, arg) {
  const name = String(action ?? "").trim().toLowerCase();
  if (!ACTIONS[name]) {
    return { ok: false, text: `Unknown action "${name}". Try: ${ACTION_NAMES.join(", ")}.` };
  }
  appendAudit({ action: "pc", name, arg: arg ? String(arg).slice(0, 80) : undefined });
  const text = await ACTIONS[name](arg);
  return { ok: true, text };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export { parsePcArgs, resolveOpenTarget, resolveVolume, ACTION_NAMES, OPEN_TARGETS };

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
          return send(200, { actions: ACTION_NAMES, openTargets: Object.keys(OPEN_TARGETS) });
        }
        const result = await runAction(body.action, body.arg);
        if (!result.ok) return send(400, { error: result.text });
        return send(200, { text: result.text });
      },
    });

    // Typed chat command, consistent with /build and /jobs: "/pc <action> [arg]".
    api.registerCommand({
      name: "pc",
      description: "Run a PC quick-action: /pc <status|disk|battery|processes|lock|open <app>|volume <up|down|mute>>",
      acceptsArgs: true,
      handler: async (ctx) => {
        const { action, arg } = parsePcArgs(ctx.args);
        if (!action) {
          return { text: `Usage: /pc <action>\nActions: ${ACTION_NAMES.join(", ")}` };
        }
        const { text } = await runAction(action, arg);
        return { text };
      },
    });
  },
};
