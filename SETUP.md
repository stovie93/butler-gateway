# Butler Gateway — End-to-end setup

This stands up the PC side that the [Butler apps](https://github.com/stovie93/butler-app)
talk to. Target OS is **Windows** (the scripts are PowerShell). Run the commands in
**PowerShell**.

At the end you'll have: a local chat model, a token-authenticated gateway reachable from
your phone over Tailscale, and the ability to dispatch live coding builds to Claude Code.

---

## 0. Prerequisites

- Windows 10/11 with a decent GPU (for a 14B–20B local model) — CPU works but is slow.
- [Node.js](https://nodejs.org) 20+.
- A Claude subscription or Anthropic API access (for Claude Code).

---

## 1. Ollama (local models)

```powershell
winget install Ollama.Ollama
ollama pull gpt-oss:20b        # chat model (pick what fits your VRAM)
ollama pull nomic-embed-text   # embeddings, for semantic memory (optional)
```

Verify: `ollama list` shows the models, and `ollama ps` works.

---

## 2. OpenClaw gateway

```powershell
npm install -g openclaw
openclaw            # first run sets up ~/.openclaw
```

Then edit `~/.openclaw/openclaw.json`. Use [`config/openclaw.example.json`](config/openclaw.example.json)
as a reference. The essentials:

- **Generate a token** and set `gateway.auth.token`:
  ```powershell
  [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')   # paste as the token
  ```
- Enable the OpenAI-compatible chat endpoint (off by default):
  `gateway.http.endpoints.chatCompletions.enabled = true`
- Point the model provider at Ollama (`models.providers.ollama`, `baseUrl http://127.0.0.1:11434`).
- Set the primary model to your Ollama chat model.
- (Optional) `agents.defaults.memorySearch` → `{ "provider": "ollama", "model": "nomic-embed-text" }`.
- Set `agents.defaults.sandbox.mode` to `non-main` so the main agent session can run the
  dispatch scripts on the host. (Dispatched builds run as their own host processes regardless.)

Apply and check:

```powershell
openclaw gateway restart
openclaw status
```

---

## 3. Claude Code (the build engine)

Install and sign in — dispatched builds shell out to the `claude` CLI:

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

Both plugins only use Node built-ins, so installing is copy + enable:

```powershell
Copy-Item "<this repo>\plugin\code-dispatch"     "$env:USERPROFILE\.openclaw\extensions\code-dispatch"     -Recurse -Force
Copy-Item "<this repo>\plugin\butler-approvals"   "$env:USERPROFILE\.openclaw\extensions\butler-approvals"   -Recurse -Force
```

Enable them in `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
"plugins": {
  "entries": {
    "code-dispatch": { "enabled": true },
    "butler-approvals": {
      "enabled": true,
      "config": {
        "sensitiveTools": [],
        "timeoutMs": 120000,
        "timeoutBehavior": "deny",
        "enableTestCommand": true
      }
    }
  }
}
```

`butler-approvals` gates the butler agent's sensitive tool calls behind an approval you grant
from the Butler app. List the tool names to gate in `sensitiveTools` (supports `*`/`?` globs);
an empty list gates nothing. `enableTestCommand` adds a `/test-approval` chat command that
creates a pending approval and waits for your decision — handy for verifying the loop before any
real sensitive tools exist. With no decision in `timeoutMs`, `timeoutBehavior` decides (default
`deny`).

Restart and confirm they loaded:

```powershell
openclaw gateway restart
openclaw plugins list   # look for "code-dispatch ... enabled" and "butler-approvals ... enabled"
```

---

## 5. Install the scripts

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

## 6. Tailscale (reach it from your phone)

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

## 7. Verify the whole chain

From the PC (loopback), with your token:

```powershell
$h = @{ Authorization = "Bearer YOUR_TOKEN"; "Content-Type" = "application/json" }

# chat endpoint
Invoke-RestMethod http://127.0.0.1:18789/v1/models -Headers $h

# dispatch a tiny build
$body = '{"action":"build","project":"hello","task":"create hello.txt containing hi"}'
Invoke-RestMethod http://127.0.0.1:18789/api/v1/code-dispatch -Method Post -Headers $h -Body $body

# watch it
Invoke-RestMethod http://127.0.0.1:18789/api/v1/code-dispatch -Method Post -Headers $h -Body '{"action":"jobsData","limit":5}'
```

---

## 8. Point the apps at it

In **butler-app** (phone) or **butler-desktop**, open Settings and enter:

- **Gateway URL** — `https://<your-pc>.<tailnet>.ts.net` (or `http://127.0.0.1:18789` on the
  PC itself / `http://<lan-ip>:18789` on the same network)
- **Token** — the `gateway.auth.token` you generated

Hit **Test**, save, and you're live.

---

## Notes & gotchas

- **Sleep:** the watcher blocks sleep only while a build (or an `/awake` hold) is active. It
  can't *wake* a machine that has already slept — on Wi-Fi-only S3 hardware there's no
  remote wake. Use `/awake 2h` before you step away, or raise the idle-sleep timeout
  (`powercfg /change standby-timeout-ac <minutes>`).
- **Encoding:** the scripts write job JSON as UTF-8-with-BOM and logs as UTF-16 (PowerShell
  defaults); the plugin already strips the BOM and detects UTF-16 when reading them back.
- **Model:** dispatched builds use whatever model the `claude` CLI is configured to use.
- **Security:** builds run with `--dangerously-skip-permissions` so they're autonomous. Keep
  the gateway tailnet-only and the token private — anyone with both can run code on your PC.
  Every `build` and `cancel` is recorded (append-only) in
  `~/.openclaw/workspace/dispatch-audit.log` for an after-the-fact trail.
- **Job lifecycle:** dispatched jobs record their runner PID, so `/cancel <id>` kills the
  process tree. On gateway start, jobs left `running` by a crash/reboot are marked
  `interrupted`, and job artifacts older than 14 days (or beyond the newest 200) are pruned.
