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

- `agent_settled` — title `Pi`, message `Ready for input`. If `pi-subagents` has active background runs in this session, the notification waits for those runs and any parent-agent turn that actually starts after completion. If no follow-up turn starts, it sends after a short grace period.
- `permissions:ask` — title `Pi`, message `Permission required: <toolName>`

The notification extension tracks `pi-subagents` lifecycle events and reconciles active runs from its status RPC when a session starts or reloads. Without `pi-subagents`, `agent_settled` notifications keep their normal behavior.

`permissions:ask` is emitted by [`@pi-lab/permissions`](https://www.npmjs.com/package/@pi-lab/permissions) immediately before a permission prompt is shown. Permission notifications are sent immediately and are not held for background runs.

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

When configured, the script is executed for every notify event in addition to the built-in notification. The script receives a JSON payload on stdin and has a fixed 5 second timeout. Failures are warned in Pi and do not affect agent execution or permission prompts.

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
