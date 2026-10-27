# notify

Desktop notification extension for [pi coding agent](https://github.com/earendil-works/pi).

This extension is based on [`anthod0/pi-lab`'s `packages/notify`](https://github.com/anthod0/pi-lab/tree/main/packages/notify), Copyright (c) 2026 anthod0, and is licensed under MIT; see [LICENSE](./LICENSE).

## Install

This extension is included in [pi-lab](https://github.com/continua-ai/pi-lab). Install the repository with:

```bash
pi install git:github.com/continua-ai/pi-lab
```

It is loaded automatically with the other pi-lab extensions.

## Behavior

This extension sends a notification for two events:

- `agent_settled` — title `Pi`, message `Ready for input`. The notification waits for this session's active background runs, foreground fleet activity, and nested children. An explicit completion wake (`triggerTurn: true`) waits for the parent's follow-up turn to settle, rather than assuming it will not start after a timeout. Results delivered to an already-running or user-aborted parent do not require a separate follow-up turn.
- `permissions:ask` — title `Pi`, message `Permission required: <toolName>`

The notification extension tracks `pi-subagents` lifecycle events and reconciles activity from its status RPC when a session starts or reloads, whenever the parent settles, and when a completion could release a held notification. While a notification is held, status is checked every five seconds to recover from missed lifecycle events. Failed or malformed status checks keep the notification held until a successful retry.

Readiness delivery has a one-second quiet period, followed by a final check that the parent is idle with no queued messages. Parent startup (including `before_agent_start`) and new child activity cancel pending delivery.

Only an active parent TUI or RPC session may send notifications. Print/JSON sessions (including same-process foreground children), background child runtimes (`PI_SUBAGENT_CHILD=1` or the matching `PI_SUBAGENT_RUNNER_PID`), and Herdr child bridges (`PI_SUBAGENTS_HERDR_BRIDGE=1`) send no desktop alerts, tmux bells, or script hooks. This applies to permission events as well as readiness events, and prevents ambient copies of this extension in children from notifying independently. Standalone headless print/JSON invocations are also silent.

Without `pi-subagents`, readiness notifications still use the quiet period and final parent-state check.

`permissions:ask` is emitted by [`@pi-lab/permissions`](https://www.npmjs.com/package/@pi-lab/permissions) immediately before a permission prompt is shown. Permission notifications in the parent TUI/RPC session are sent immediately and are not held for background runs. Child sessions never notify independently.

When `PI_INSIDE_FROSTPI=1`, this extension suppresses all notifications, including built-in desktop notifications, tmux alerts, and configured script hooks.

When Pi runs inside tmux, each notification also emits a terminal bell. For a background window, tmux marks and highlights its window label until the window is selected. This requires tmux's `monitor-bell` window option, which is enabled by default. The highlight uses `window-status-bell-style` and can be customized in `~/.tmux.conf`:

```tmux
setw -g monitor-bell on
set -g window-status-bell-style 'fg=yellow,bold'
```

## Notification backend

The built-in notification backend is auto-detected:

- Windows Terminal / WSL: PowerShell toast
- Kitty: OSC 99
- Other terminals: OSC 777

Click handling is not implemented by the built-in backend. Use the script hook for terminal- or OS-specific click behavior.

## Configuration

Configuration files:

- Global: `~/.pi/agent/pi-lab/notify.json`
- Local: `<cwd>/.pi/pi-lab/notify.json`

Local config overrides global config.

### Disable built-in notifications

```json
{
  "notify": {
    "enable": false
  }
}
```

`enable` defaults to `true` and controls built-in desktop notifications and tmux window alerts. Script hooks still run when `enable` is `false`.

### Script hook

```json
{
  "notify": {
    "script": "~/.pi/agent/pi-lab/notify.sh"
  }
}
```

When configured, the script is executed for every eligible parent-session notify event in addition to the built-in notification. The script receives a JSON payload on stdin and has a fixed 5 second timeout. Failures appear as Pi UI warnings (or console warnings when the parent UI is unavailable) and do not affect agent execution or permission prompts.

Example payload for `agent_settled`:

```json
{
  "event": "agent_settled",
  "notificationId": "pi-agent-settled-1778220000000",
  "title": "Pi",
  "message": "Ready for input",
  "timestamp": 1778220000000,
  "cwd": "/home/user/project",
  "pid": 12345,
  "terminal": {
    "term": "xterm-kitty",
    "termProgram": "kitty",
    "kittyWindowId": "1"
  }
}
```

Example payload for `permissions:ask`:

```json
{
  "event": "permission_ask",
  "notificationId": "pi-permission-ask-1778220000000",
  "title": "Pi",
  "message": "Permission required: bash",
  "timestamp": 1778220000000,
  "cwd": "/home/user/project",
  "pid": 12345,
  "terminal": {
    "term": "xterm-kitty",
    "termProgram": "kitty",
    "kittyWindowId": "1"
  }
}
```

Unavailable terminal fields are omitted from the JSON sent to the script.

The script payload intentionally does not include raw tool input, permission rules, options, or tool call identifiers.

Example script:

```bash
#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"
message="$(jq -r .message <<<"$payload")"
notify-send "Pi" "$message"
```
