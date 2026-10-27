import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Kitty functional keys: play/pause, next/previous track, volume down/up.
// Match presses, repeats, and releases, including modifier/event parameters.
const MEDIA_KEYS = /\x1b\[(?:57430|57435|57436|57438|57439)(?:;\d+(?::[123])?)?u/g;

export default function mediaKeys(pi: ExtensionAPI): void {
  let unsubscribe: (() => void) | undefined;

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    cleanup();
    if (ctx.mode !== "tui") return;

    unsubscribe = ctx.ui.onTerminalInput((data) => {
      // Pasted escape sequences are content, not keyboard events.
      if (data.startsWith("\x1b[200~")) return;

      const filtered = data.replace(MEDIA_KEYS, "");
      if (filtered === data) return;
      return filtered ? { data: filtered } : { consume: true };
    });
  });

  pi.on("session_shutdown", cleanup);
}
