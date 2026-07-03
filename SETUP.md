# Butler Gateway — End-to-end setup

This stands up the PC side that the [Butler apps](https://github.com/stovie93/butler-app)
talk to. Target OS is **Windows** (the scripts are PowerShell). Run the commands in
**PowerShell**.

At the end you'll have: a local chat model with a persistent persona and memory, a
token-authenticated gateway reachable from your phone over Tailscale, phone-approved
command execution, scheduled check-ins that push to your phone, live web answers, and the
ability to dispatch coding builds to Claude Code.

**Minimal path:** steps 1, 2, 4, 9, and 11 give you a working chat app with memory,
persona, awareness, and approvals. Everything else (Claude Code builds, push
notifications, web search, heartbeats) layers on top and is clearly marked optional.

---

## 0. Prerequisites

- Windows 10/11 with a decent GPU (for a 14B–20B local model) — CPU works but is slow.
- [Node.js](https://nodejs.org) 20+.
- Optional, per feature:
  - A **Claude subscription** or Anthropic API access — only for dispatched Claude Code builds and the cloud brain (step 3).
  - A free **[Tavily](https://tavily.com)** API key — only for live web search (step 6).
  - A free **[Firebase](https://console.firebase.google.com)** project — only for push notifications to the phone (step 5).

---

## 1. Ollama (local models)

```powershell
winget install Ollama.Ollama
ollama pull gpt-oss:20b        # chat model (pick what fits your VRAM)
ollama pull nomic-embed-text   # embeddings — REQUIRED for the memory features
```

Verify: `ollama list` shows the models, and `ollama ps` works.

> `nomic-embed-text` powers semantic memory (remember/recall, auto-recall, journals).
> Skip it only if you also skip `butler-memory` and `butler-awareness`.

---

## 2. OpenClaw gateway

```powershell
npm install -g openclaw
openclaw            # first run sets up ~/.openclaw
```

Then edit `~/.openclaw/openclaw.json`. Use [`config/openclaw.example.json`](config/openclaw.example.json)
as a reference — it now contains a complete working layout for every plugin in this repo.
The essentials:

- **Generate a token** and set `gateway.auth.token`:
  ```powershell
  [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')   # paste as the token
  ```
- Enable the OpenAI-compatible chat endpoint (off by default):
  `gateway.http.endpoints.chatCompletions.enabled = true`
- Point the model provider at Ollama (`models.providers.ollama`, `baseUrl http://127.0.0.1:11434`).
- Set the primary model to your Ollama chat model.
- `agents.defaults.memorySearch` → `{ "provider": "ollama", "model": "nomic-embed-text" }`
  (required for the memory features).
- Set `agents.defaults.sandbox.mode` to `non-main` so the main agent session can run the
  dispatch scripts on the host. (Dispatched builds run as their own host processes regardless.)

> ⚠️ **Editing openclaw.json:** OpenClaw writes this file **UTF-8 with a BOM**. Most
> editors preserve it fine, but if you script edits (node/python), strip a leading
> `﻿` before `JSON.parse` and re-prepend it on write, or the gateway may reject the file.

Apply and check:

```powershell
openclaw gateway restart
openclaw status
```

---

## 3. Claude Code — optional, for builds + the cloud brain

Only needed for the **Build** tab / `build_project` and the `butler-brain` escalation
("ask Claude …"). Install and sign in — both shell out to the `claude` CLI:

```powershell
npm install -g @anthropic-ai/claude-code
claude         # complete the login once
```

Confirm headless mode works:

```powershell
"say hi" | claude -p --output-format stream-json --verbose --dangerously-skip-permissions
```

You should see JSON event lines ending in a `"type":"result"` event.

---

## 4. Install the plugins

All plugins use only Node built-ins — installing is copy + enable. Copy **all of them**:

```powershell
Get-ChildItem "<this repo>\plugin" -Directory | ForEach-Object {
  Copy-Item $_.FullName "$env:USERPROFILE\.openclaw\extensions\$($_.Name)" -Recurse -Force
}
```

### What each one does

| Plugin | What it adds | Needs config? |
| --- | --- | --- |
| `butler-persona` | Persistent personality (default: "Clawdia"), editable from the app's Persona screen. Rendered into the workspace identity files on every change. | no |
| `butler-memory` | Durable memory: `remember`/`recall`/`forget` tools, guaranteed capture of "remember that…" requests, passive capture of facts stated offhand, and an end-of-session journal. | no (defaults fine) |
| `butler-awareness` | Injects a compact context block into **every** turn: current date/time, running builds, pending reminders, and auto-recalled memories. This is what makes a small local model feel present. | no |
| `butler-approvals` | The approval relay: sensitive tool calls block until you approve/deny from the phone; also the generic phone-push route other plugins use. | `sensitiveTools`, `fcm` for push |
| `butler-shell` | `run_command` — the agent can propose **any** PowerShell command; it only runs after you approve the exact command text on your phone. Deny/timeout/unreachable all fail closed. Audited. | optional caps |
| `butler-pc` | PC tab: live status (CPU/RAM/disk/uptime), process list, and approval-gated power actions. | no |
| `butler-reminders` | Timed reminders (`set_reminder` etc.) with PC toast + phone push delivery. | `fcm` for push |
| `butler-heartbeat` | Scheduled agent check-ins (e.g. a daily 08:00 morning briefing) pushed to the phone, plus a tool that lets the agent message you unprompted. | `entries`, `quietHours` |
| `butler-websearch` | Live web answers on explicit search intent (Tavily), and server-side fetch of any URL you paste so the model answers from the actual page. | Tavily key |
| `butler-brain` | Cloud-brain escalation: say "ask Claude …" (or accept the model's offer) and the question is handed to Claude on the PC; the answer drops into the chat and arrives as a push. The tap in the app is the consent — it never escalates on its own. | no (needs step 3) |
| `butler-models` | Lists the allowed Ollama models so the app's model picker works; per-request switching. | no |
| `code-dispatch` | Dispatch coding jobs to Claude Code with live streaming logs (`/build`, `/jobs`, `/cancel`, `/awake` + the JSON route the apps use). | no (needs step 3 + 8) |

### Enable them

In `~/.openclaw/openclaw.json` under `plugins.entries` (see the example config for the
full block in place):

```json
"plugins": {
  "entries": {
    "code-dispatch": { "enabled": true },
    "butler-persona": { "enabled": true },
    "butler-memory": { "enabled": true, "config": { "reindexOnWrite": true } },
    "butler-awareness": { "enabled": true },
    "butler-pc": { "enabled": true },
    "butler-models": { "enabled": true },
    "butler-shell": { "enabled": true },
    "butler-websearch": { "enabled": true },
    "butler-brain": { "enabled": true },
    "butler-approvals": {
      "enabled": true,
      "config": {
        "sensitiveTools": ["pc_power", "build_project"],
        "timeoutMs": 120000,
        "timeoutBehavior": "deny",
        "enableTestCommand": true
      }
    },
    "butler-reminders": { "enabled": true, "config": { "pushNotify": true } },
    "butler-heartbeat": {
      "enabled": true,
      "config": {
        "entries": [
          {
            "id": "morning-briefing",
            "at": "08:00",
            "mode": "always",
            "title": "Butler ☀️",
            "prompt": "Good morning! This is your scheduled morning heartbeat. Using what you can see right now (the time, anything running on the PC, pending reminders, what you remember), write a short, warm good-morning message for the day ahead. Keep it under 80 words, plain text, no markdown."
          }
        ],
        "quietHours": { "start": "22:00", "end": "08:00" }
      }
    }
  }
}
```

Notes on that block:

- **`sensitiveTools`** lists tool names (globs OK) that must be phone-approved before they
  run. **Do NOT add `run_command` here** — `butler-shell` requests approval internally, and
  listing it would double-prompt.
- **Heartbeat entries:** `at: "08:00"` fires once a day (with a 3-hour catch-up window if
  the PC was off), or use `every: "2h"` for intervals. `mode: "always"` always delivers;
  `mode: "decide"` lets the model stay silent when there's nothing worth saying. `every`
  beats respect `quietHours`. Manual test fire:
  `POST /api/v1/heartbeat {"action":"run","id":"morning-briefing"}`.

### ⚠️ Allow-list the plugin tools (easy to miss)

The agent's tool profile **strips unknown tools** — plugin tools silently disappear unless
they're allow-listed. Add this at the **top level** of `openclaw.json`:

```json
"tools": {
  "alsoAllow": [
    "pc_action", "pc_power",
    "set_reminder", "list_reminders", "cancel_reminder",
    "remember", "recall", "forget",
    "notify_owner",
    "run_command"
  ]
}
```

If a plugin loads fine but the model claims it "doesn't have that tool", this is almost
always why.

Restart and confirm they loaded:

```powershell
openclaw gateway restart
openclaw plugins list   # every plugin above should show "enabled"
```

---

## 5. Push notifications (optional — Firebase FCM)

Without this, everything still works while the app is open (it streams/polls). Push is
what makes reminders, approvals, and heartbeats reach a **closed** app.

**PC side:**

1. Create a free project at [console.firebase.google.com](https://console.firebase.google.com).
2. Project settings → **Service accounts** → **Generate new private key** → save the JSON as
   `~/.openclaw/fcm-service-account.json`.
3. Add the `fcm` block to **both** `butler-approvals` and `butler-reminders` config:

```json
"fcm": {
  "projectId": "your-firebase-project-id",
  "serviceAccountPath": "C:\\Users\\YOU\\.openclaw\\fcm-service-account.json"
}
```

**App side:** in the same Firebase project, add an **Android app** with package name
`com.stovie93.butler`, download `google-services.json`, drop it in the butler-app repo
root, and **build the APK from source** (see the butler-app README).

> ⚠️ The prebuilt release APKs have the maintainer's Firebase project baked in, so push
> **only works with your own build**. Everything else works fine with a release APK.

The app registers its device token with the gateway automatically on connect. Restart the
gateway and test: create a reminder 1 minute out, close the app, wait for the push.

---

## 6. Web search (optional — Tavily)

Get a free API key from [tavily.com](https://tavily.com) and add it to `plugins.entries`:

```json
"tavily": { "enabled": true, "config": { "webSearch": { "apiKey": "tvly-..." } } }
```

`butler-websearch` reuses this key. It only fires on an explicit search intent ("look up…",
"what's the latest…", a pasted URL) — never on ordinary chat — and every outbound query is
logged to `~/.openclaw/workspace/websearch-audit.log`. Pasted-URL fetches never leave your
machine except to the URL itself (private/loopback addresses are refused) and need **no**
API key.

---

## 7. Cloud brain (optional — needs Claude Code from step 3)

With `butler-brain` enabled, the local model gains an escape hatch for genuinely hard
questions. Say **"ask Claude …"** in chat (or accept when the model itself offers) and the
reply ends with an invisible `[[ASK: question=…]]` action marker that the app turns into a
tap-to-ask card. The tap is the consent — escalation uses your Claude subscription, so the
model can never spend it on its own. `claude -p` runs headless in the background; the
answer fills into the chat a minute or two later and also arrives as a push if the app is
closed. Runs are recorded under `~/.openclaw/workspace/brain/` and audited in
`brain-audit.log`.

Optional config (defaults are sensible):

```json
"butler-brain": {
  "enabled": true,
  "config": { "timeoutMs": 300000, "maxAnswerChars": 6000, "model": "", "nudge": true }
}
```

> **Action markers**, for the curious: `[[NAME: key=value | key=value]]` on the last line
> of a reply is the convention the gateway uses to let a small local model *propose*
> actions as plain text (which it does reliably) instead of tool calls (which it doesn't).
> The app renders known markers as confirm cards — `[[BUILD: …]]` and `[[ASK: …]]` today —
> and strips unknown ones, so new markers can ship gateway-first.

---

## 8. Install the scripts (needed for code-dispatch)

```powershell
$ws = "$env:USERPROFILE\.openclaw\workspace\scripts"
New-Item -ItemType Directory -Force $ws | Out-Null
Copy-Item "<this repo>\scripts\dispatch-claude.ps1" $ws
Copy-Item "<this repo>\scripts\check-claude.ps1"    $ws
Copy-Item "<this repo>\scripts\cancel-claude.ps1"   $ws
Copy-Item "<this repo>\scripts\openclaw-awake.ps1"  "$env:USERPROFILE\openclaw-awake.ps1"
```

- `dispatch-claude.ps1` / `check-claude.ps1` / `cancel-claude.ps1` are called by the plugin (it
  looks for them in `~/.openclaw/workspace/scripts`). Dispatched projects are created under
  `~/repos/<name>`.
- `openclaw-awake.ps1` is the keep-awake watcher. Start it once (it's a singleton):
  ```powershell
  Start-Process powershell -ArgumentList "-NoProfile","-WindowStyle","Hidden","-File","$env:USERPROFILE\openclaw-awake.ps1"
  ```
  To make it survive reboots, launch it from your gateway startup (e.g. add the same line to
  `~/.openclaw/gateway.cmd`, which OpenClaw runs at login).

---

## 9. Tailscale (reach it from your phone)

```powershell
winget install Tailscale.Tailscale
tailscale up                       # sign in
```

Enable HTTPS for your tailnet (one-time, via the link the next command prints if needed),
then serve the gateway:

```powershell
tailscale serve --bg --yes 18789
tailscale serve status             # shows https://<your-pc>.<tailnet>.ts.net  ->  127.0.0.1:18789
```

Install the **Tailscale** app on your phone and sign in with the **same account**.

> Same-Wi-Fi alternative: skip Tailscale and point the apps at `http://<pc-lan-ip>:18789`
> (set `gateway.bind` accordingly). Tailscale is what makes it work from anywhere.

---

## 10. Verify the whole chain

From the PC (loopback), with your token:

```powershell
$h = @{ Authorization = "Bearer YOUR_TOKEN"; "Content-Type" = "application/json" }

# chat endpoint
Invoke-RestMethod http://127.0.0.1:18789/v1/models -Headers $h

# memory round-trip (then ask "what's my cat's name?" in a NEW chat)
$body = '{"model":"gpt-oss:20b","user":"setup-test","messages":[{"role":"user","content":"Remember that my cat is named Pixel."}]}'
Invoke-RestMethod http://127.0.0.1:18789/v1/chat/completions -Method Post -Headers $h -Body $body

# heartbeat: list schedules, then fire one manually
Invoke-RestMethod http://127.0.0.1:18789/api/v1/heartbeat -Method Post -Headers $h -Body '{"action":"list"}'
Invoke-RestMethod http://127.0.0.1:18789/api/v1/heartbeat -Method Post -Headers $h -Body '{"action":"run","id":"morning-briefing"}'

# cloud brain (needs Claude Code): fire a question, then poll the returned id
Invoke-RestMethod http://127.0.0.1:18789/api/v1/brain -Method Post -Headers $h -Body '{"action":"ask","question":"In one sentence, what is a monad?"}'
Invoke-RestMethod http://127.0.0.1:18789/api/v1/brain -Method Post -Headers $h -Body '{"action":"list"}'

# approval loop (a card should appear in the app's Approvals tab / on your phone)
# — or type /test-approval in chat if enableTestCommand is true

# dispatch a tiny build (needs Claude Code + scripts)
$body = '{"action":"build","project":"hello","task":"create hello.txt containing hi"}'
Invoke-RestMethod http://127.0.0.1:18789/api/v1/code-dispatch -Method Post -Headers $h -Body $body
Invoke-RestMethod http://127.0.0.1:18789/api/v1/code-dispatch -Method Post -Headers $h -Body '{"action":"jobsData","limit":5}'
```

In the app itself: ask it to run a PowerShell command ("how many folders are in my repos
directory?") — an approval card with the **exact command text** should hit your phone, and
the answer should arrive only after you approve.

---

## 11. Point the apps at it

In **butler-app** (phone), the first-run setup wizard asks for these (rerun it from
Settings → 🚀 Setup wizard); in **butler-desktop**, open Settings and enter:

- **Gateway URL** — `https://<your-pc>.<tailnet>.ts.net` (or `http://127.0.0.1:18789` on the
  PC itself / `http://<lan-ip>:18789` on the same network)
- **Token** — the `gateway.auth.token` you generated

Hit **Test**, save, and you're live.

---

## Notes & gotchas

- **Plugin tools vanish?** You forgot `tools.alsoAllow` (step 4). This is the #1 setup trap.
- **Owner name:** set **your name** in the app's Persona screen (stored as `owner` in
  `~/.openclaw/workspace/persona.json`). Every plugin reads it from there — memories are
  captured as "«you» is allergic to…", the awareness block says "On «you»'s PC", journals
  and nudges use it. Until it's set, everything falls back to generic wording.
- **Sleep:** the watcher blocks sleep only while a build (or an `/awake` hold) is active. It
  can't *wake* a machine that has already slept — on Wi-Fi-only S3 hardware there's no
  remote wake. Use `/awake 2h` before you step away, or raise the idle-sleep timeout
  (`powercfg /change standby-timeout-ac <minutes>`).
- **PC off = butler off.** Heartbeats, reminders, and pushes only happen while the PC is
  on; daily `at:` heartbeats have a 3-hour catch-up window for morning boots.
- **Encoding:** the dispatch scripts write job JSON as UTF-8-with-BOM and logs as UTF-16
  (PowerShell defaults); the plugin already strips the BOM and detects UTF-16 when reading
  them back. `openclaw.json` itself is UTF-8-with-BOM (see step 2).
- **Model:** dispatched builds use whatever model the `claude` CLI is configured to use.
  Chat/heartbeat/journal turns use your Ollama primary; per-request override via the
  `x-openclaw-model` header (must be in `agents.defaults.models`).
- **Security:** builds run with `--dangerously-skip-permissions` so they're autonomous. Keep
  the gateway tailnet-only and the token private — anyone with both can run code on your PC.
  Audit trails: `dispatch-audit.log` (builds), `shell-audit.log` (run_command),
  `websearch-audit.log` (outbound searches), `heartbeat.log` (beats), and
  `approvals/<id>.json` records — all under `~/.openclaw/workspace/`.
- **Job lifecycle:** dispatched jobs record their runner PID, so `/cancel <id>` kills the
  process tree. On gateway start, jobs left `running` by a crash/reboot are marked
  `interrupted`, and job artifacts older than 14 days (or beyond the newest 200) are pruned.
