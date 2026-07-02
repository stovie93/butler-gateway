# 🤖 Butler Gateway

**The PC-side brain behind the Butler apps.** This repo holds the server pieces that make
[butler-app](https://github.com/stovie93/butler-app) (Android) and
[butler-desktop](https://github.com/stovie93/butler-desktop) (Electron) actually do
anything: a suite of [OpenClaw](https://openclaw.ai) plugins and scripts that give your
local model a **persona, durable memory, situational awareness, phone-approved hands, a
schedule, live web access**, and the ability to **dispatch real coding jobs to Claude
Code** that build autonomously on your PC while you watch the progress live.

If the apps are the remote controls, this is the machine they control.

---

## What's in here

```
plugin/butler-persona/     the assistant's editable personality, injected every turn (app has an editor)
plugin/butler-memory/      durable memory: remember/recall/forget tools + guaranteed & passive capture + session journal
plugin/butler-awareness/   per-turn context inject: clock, PC state, pending reminders, auto-recalled memories
plugin/butler-approvals/   approval relay: sensitive tool calls block until you approve from the app (POST /api/v1/approvals + SSE /stream); also the generic phone-push route
plugin/butler-shell/       run_command — any PowerShell command, gated behind a phone approval of the exact command text, audited
plugin/butler-pc/          PC status, processes, and approval-gated power actions
plugin/butler-reminders/   timed reminders with PC toast + phone push delivery
plugin/butler-heartbeat/   scheduled agent check-ins pushed to the phone + an unprompted-message tool
plugin/butler-websearch/   live web answers (Tavily) + server-side fetch of pasted URLs, SSRF-guarded, audited
plugin/butler-models/      model list/switch for the app's model picker
plugin/code-dispatch/      POST /api/v1/code-dispatch (+ SSE /stream) and /build /jobs /cancel /awake chat commands
scripts/dispatch-claude.ps1   launches a headless Claude Code build for a project, tracks it as a job (records PID + result summary)
scripts/check-claude.ps1      lists/inspects jobs and marks them reported
scripts/cancel-claude.ps1     cancels a running job (kills the runner process tree, marks it canceled)
scripts/openclaw-awake.ps1    keeps the PC awake only while a build (or an /awake hold) is active
config/openclaw.example.json  complete example gateway config (all plugins wired; secrets are placeholders)
SETUP.md                      full end-to-end install + run guide
```

## What it provides

Once set up, the gateway exposes (token-authenticated, tailnet-only):

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat against your local Ollama model (streaming), with persona + awareness + memory injected every turn |
| `POST /api/v1/code-dispatch` | `build` / `cancel` / `jobsData` / `jobLog` / `awake` / `status` actions used by the apps |
| `GET /api/v1/code-dispatch/stream?jobId=` | SSE live job-log stream (real-time progress; apps fall back to polling) |
| `POST /api/v1/approvals` | `request` / `list` / `decide` / `history` / `notify` — the approval loop + generic phone push |
| `GET /api/v1/approvals/stream` | SSE live approval stream (pending/resolved events for the app) |
| `POST /api/v1/memory` | `list` / `add` / `delete` / `journal` — the app's Memory screen + end-of-session journal |
| `POST /api/v1/reminders` | list/cancel reminders from the app |
| `POST /api/v1/pc` | PC status, processes, power actions |
| `POST /api/v1/heartbeat` | `list` / `run` — inspect and manually fire scheduled check-ins |
| `POST /api/v1/shell` | propose a command (same approval gate as the `run_command` tool) |
| `POST /api/v1/persona`, `/api/v1/chat-models`, `/api/v1/notifications` | the app's Persona editor, model picker, and notification history |
| `/build`, `/jobs`, `/cancel`, `/awake` | the same dispatch actions as chat commands (e.g. over WhatsApp) |

Dispatched builds run `claude -p --output-format stream-json`, so job logs fill in **live**
and the apps can show real-time progress.

## How a build flows

```
app  ──▶  POST /api/v1/code-dispatch {action:"build", project, task}
            └─ code-dispatch plugin  ──▶  dispatch-claude.ps1
                                            └─ claude -p (headless, streaming) in ~/repos/<project>
                                                 └─ writes job json + live log to ~/.openclaw/workspace/jobs/
                                                 └─ on finish: wakes the agent to message you
```

---

## ⚠️ Platform note

The scripts are **Windows PowerShell** and the keep-awake watcher uses the Windows
`SetThreadExecutionState` API. The OpenClaw plugin itself is plain Node and is
cross-platform; the scripts would need porting to `bash` for macOS/Linux.

## Setup

See **[SETUP.md](SETUP.md)** for the complete step-by-step (Ollama → OpenClaw → plugins →
optional Claude Code / push / web search → scripts → Tailscale → verify). The minimal path
(chat + memory + persona + approvals) needs no paid accounts at all. No secrets are
committed here; you generate your own token during setup.
