# 🤖 Butler Gateway

**The PC-side brain behind the Butler apps.** This repo holds the server pieces that make
[butler-app](https://github.com/stovie93/butler-app) (Android) and
[butler-desktop](https://github.com/stovie93/butler-desktop) (Electron) actually do
anything: an [OpenClaw](https://openclaw.ai) plugin and a set of scripts that let your phone
or desktop **chat with a local model** and **dispatch real coding jobs to Claude Code**,
which build autonomously on your PC while you watch the progress live.

If the apps are the remote controls, this is the machine they control.

---

## What's in here

```
plugin/code-dispatch/      OpenClaw plugin: adds POST /api/v1/code-dispatch (+ SSE /stream) and /build /jobs /cancel /awake chat commands
plugin/butler-approvals/   OpenClaw plugin: gates the agent's sensitive tool calls behind an approval you grant from the app (POST /api/v1/approvals + SSE /stream)
scripts/dispatch-claude.ps1   launches a headless Claude Code build for a project, tracks it as a job (records PID + result summary)
scripts/check-claude.ps1      lists/inspects jobs and marks them reported
scripts/cancel-claude.ps1     cancels a running job (kills the runner process tree, marks it canceled)
scripts/openclaw-awake.ps1    keeps the PC awake only while a build (or an /awake hold) is active
config/openclaw.example.json  sanitized example gateway config (token redacted)
SETUP.md                      full end-to-end install + run guide
```

## What it provides

Once set up, the gateway exposes (token-authenticated, tailnet-only):

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat against your local Ollama model (streaming) |
| `POST /api/v1/code-dispatch` | `build` / `cancel` / `jobsData` / `jobLog` / `awake` / `status` actions used by the apps |
| `GET /api/v1/code-dispatch/stream?jobId=` | SSE live job-log stream (real-time progress; apps fall back to polling) |
| `POST /api/v1/approvals` | `list` / `decide` / `history` — pending approvals the agent is waiting on |
| `GET /api/v1/approvals/stream` | SSE live approval stream (pending/resolved events for the app) |
| `/build`, `/jobs`, `/cancel`, `/awake` | the same actions as chat commands (e.g. over WhatsApp) |

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

See **[SETUP.md](SETUP.md)** for the complete step-by-step (Ollama → OpenClaw → Claude Code
→ plugin → scripts → Tailscale → verify). No secrets are committed here; you generate your
own token during setup.
