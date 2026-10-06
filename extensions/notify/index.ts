import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadConfig, type NotifyConfig } from "./config.js";
import { sendDesktopNotification, sendTmuxWindowAlert } from "./notifier.js";
import { runNotifyScript, type NotifyPayload, type TerminalContext } from "./script.js";
import {
  activeSubagentIdsFromRpcReply,
  SUBAGENT_ASYNC_COMPLETE_EVENT,
  SUBAGENT_ASYNC_STARTED_EVENT,
  SUBAGENT_RPC_READY_EVENT,
  SUBAGENT_RPC_REPLY_EVENT_PREFIX,
  SUBAGENT_RPC_REQUEST_EVENT,
  SubagentNotificationGate,
} from "./subagents.js";

type PermissionsAskEvent = {
  toolCallId?: unknown;
  toolName?: unknown;
};

type NotifyDeps = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  sendNotification?: (title: string, message: string) => void;
  sendTmuxAlert?: () => void;
  runScript?: (script: string, payload: NotifyPayload) => void | Promise<void>;
  warn?: (message: string) => void;
};

const TITLE = "Pi" as const;
const AGENT_SETTLED_MESSAGE = "Ready for input";

export default function (pi: ExtensionAPI, deps: NotifyDeps = {}) {
  let config: NotifyConfig = { enable: true };
  let currentCwd = process.cwd();
  let currentSessionId: string | undefined;
  let subagentRpcReady = false;
  let statusSync: { requestId: string; timeout: NodeJS.Timeout; unsubscribe: () => void } | undefined;
  let statusRetry: NodeJS.Timeout | undefined;
  let statusSyncWarningLogged = false;

  const env = deps.env ?? process.env;
  const sendNotification = deps.sendNotification ?? sendDesktopNotification;
  const sendTmuxAlert = deps.sendTmuxAlert ?? sendTmuxWindowAlert;
  const runScript = deps.runScript ?? runNotifyScript;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const notificationGate = new SubagentNotificationGate((payload) => {
    void handleNotify(payload);
  });

  pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, (data: unknown) => {
    notificationGate.trackStarted(data);
  });
  pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (data: unknown) => {
    notificationGate.trackCompleted(data);
  });
  pi.events.on(SUBAGENT_RPC_READY_EVENT, () => {
    subagentRpcReady = true;
    if (currentSessionId) syncActiveSubagents();
  });

  pi.on("session_start", async (_event, ctx) => {
    cancelStatusSync();
    currentCwd = ctx.cwd;
    currentSessionId = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    config = loadConfig(ctx.cwd, deps.home);
    notificationGate.reset(currentSessionId);
    statusSyncWarningLogged = false;
    if (subagentRpcReady) syncActiveSubagents();
  });

  pi.on("agent_start", () => {
    notificationGate.parentAgentStarted();
  });

  pi.on("agent_end", () => {
    notificationGate.parentAgentStopped();
  });

  pi.on("agent_settled", async () => {
    notificationGate.settle(createPayload("agent_settled", AGENT_SETTLED_MESSAGE));
  });

  pi.on("session_shutdown", () => {
    cancelStatusSync();
    notificationGate.reset(undefined);
  });

  pi.events.on("permissions:ask", (data: unknown) => {
    const event = isPermissionsAskEvent(data) ? data : {};
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    void handleNotify(createPayload("permission_ask", `Permission required: ${toolName}`));
  });

  function cancelStatusSync(clearRetry = true): void {
    if (statusSync) {
      clearTimeout(statusSync.timeout);
      statusSync.unsubscribe();
      statusSync = undefined;
    }
    if (clearRetry && statusRetry) {
      clearTimeout(statusRetry);
      statusRetry = undefined;
    }
  }

  function scheduleStatusSyncRetry(): void {
    if (statusRetry) return;
    statusRetry = setTimeout(() => {
      statusRetry = undefined;
      syncActiveSubagents();
    }, 5000);
  }

  function syncActiveSubagents(): void {
    if (!currentSessionId || !subagentRpcReady) return;
    if (statusRetry) {
      clearTimeout(statusRetry);
      statusRetry = undefined;
    }
    cancelStatusSync(false);

    const requestId = randomUUID();
    const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
    notificationGate.beginStatusSync();

    const finish = (reply?: unknown) => {
      if (!statusSync || statusSync.requestId !== requestId) return;
      clearTimeout(statusSync.timeout);
      statusSync.unsubscribe();
      statusSync = undefined;
      const activeRunIds = reply === undefined ? undefined : activeSubagentIdsFromRpcReply(reply);
      if (activeRunIds === undefined) {
        if (!statusSyncWarningLogged) {
          warn("notify: could not reconcile active pi-subagents status; retrying before sending settled notifications");
          statusSyncWarningLogged = true;
        }
        scheduleStatusSyncRetry();
        return;
      }
      statusSyncWarningLogged = false;
      notificationGate.reconcileStatus(activeRunIds);
    };

    const unsubscribe = pi.events.on(replyEvent, (reply: unknown) => {
      if (isRpcReplyForRequest(reply, requestId)) finish(reply);
    });
    const timeout = setTimeout(() => finish(), 5000);
    statusSync = { requestId, timeout, unsubscribe };

    pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
      version: 1,
      requestId,
      method: "status",
      params: {},
    });
  }

  function createPayload(event: NotifyPayload["event"], message: string): NotifyPayload {
    const timestamp = Date.now();
    return {
      event,
      notificationId: `${event === "agent_settled" ? "pi-agent-settled" : "pi-permission-ask"}-${timestamp}`,
      title: TITLE,
      message,
      timestamp,
      cwd: currentCwd,
      pid: process.pid,
      terminal: getTerminalContext(env),
    };
  }

  async function handleNotify(payload: NotifyPayload): Promise<void> {
    if (env.PI_INSIDE_FROSTPI === "1") return;

    if (config.enable) {
      sendNotification(payload.title, payload.message);
      if (payload.terminal.tmux) {
        sendTmuxAlert();
      }
    }
    if (config.script) {
      try {
        await runScript(config.script, payload);
      } catch (error) {
        warn(`notify script failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function isPermissionsAskEvent(value: unknown): value is PermissionsAskEvent {
  return typeof value === "object" && value !== null;
}

function isRpcReplyForRequest(value: unknown, requestId: string): boolean {
  return typeof value === "object" && value !== null && "requestId" in value && value.requestId === requestId;
}

function getTerminalContext(env: NodeJS.ProcessEnv): TerminalContext {
  return {
    term: env.TERM,
    termProgram: env.TERM_PROGRAM,
    kittyWindowId: env.KITTY_WINDOW_ID,
    weztermPane: env.WEZTERM_PANE,
    wtSession: env.WT_SESSION,
    tmux: env.TMUX,
  };
}
