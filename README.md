# pi-lab

A small collection of [pi](https://github.com/badlogic/pi-mono) (pi-coding-agent) extensions from your friends at Continua.

## Install

```bash
pi install git:github.com/continua-ai/pi-lab
```

After install, restart `pi` (or run `/reload`) and the extensions in this repo will be available.

## Extensions

- `media-keys`: prevents Kitty-protocol play/pause, next/previous track, and volume up/down events from appearing as characters in the editor (notably in VS Code's terminal). Filters press/repeat/release events inside Pi without intercepting OS media controls. Remove any temporary VS Code media-key bindings or standalone `filter-media-keys.ts` workaround, then run `/reload`.

- `subscription-fallback` (`/subswitch`): multi-vendor (OpenAI/Claude) route failover manager with preference stack, guided setup (+ validate-now checks), OAuth/API routes, persisted cooldown/holdoff/event state, context-window-aware switching/compaction, `/subswitch explain` + `/subswitch events`, continuation fallback, and background return-to-preferred probing.
- `title-status`: shows a small status icon (busy/ready/pending) in the terminal title.
- `vscode-local-links`: expands `[path:line](vscode-local:)` into clickable VS Code Dev Container links when Pi renders assistant Markdown in Herdr. Paths are relative to the launch directory or absolute. The remote authority comes from the `Authority:` entry in `~/.pi/agent/AGENTS.md`; run `/reload` after changing it. The saved transcript keeps the short form.
- `live-commentary`: summarizes long-running bash tool output with a small widget (auto-starts after ~10s).
- `session-context` (`/session-context`): generates a dedicated session summary line below the editor and a detailed modal on demand.
- `notify`: sends desktop notifications when the agent is ready for input (after active pi-subagents background runs finish) or a permission prompt is required, with tmux window alerts and an optional script hook.
