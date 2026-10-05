import type { NotifyPayload } from "./script.js";

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

type RunChange = { id: string; active: boolean; triggerParentRun?: boolean };

export class SubagentNotificationGate {
  private sessionId: string | undefined;
  private activeRuns = new Set<string>();
  private pendingNotification: NotifyPayload | undefined;
  private statusSyncPending = false;
  private statusSyncChanges: RunChange[] | undefined;
  private awaitingTriggeredParentRun = false;
  private triggeredParentRunStarted = false;
  private triggerAfterGeneration = 0;
  private parentRunGeneration = 0;
  private parentAgentBusy = false;
  private noFollowupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly notify: (payload: NotifyPayload) => void,
    private readonly noFollowupGraceMs = 1000,
  ) {}

  reset(sessionId: string | undefined): void {
    this.clearNoFollowupTimer();
    this.sessionId = sessionId;
    this.activeRuns.clear();
    this.pendingNotification = undefined;
    this.statusSyncPending = false;
    this.statusSyncChanges = undefined;
    this.awaitingTriggeredParentRun = false;
    this.triggeredParentRunStarted = false;
    this.triggerAfterGeneration = 0;
    this.parentRunGeneration = 0;
    this.parentAgentBusy = false;
  }

  beginStatusSync(): void {
    if (this.statusSyncPending) return;
    this.statusSyncPending = true;
    this.statusSyncChanges = [];
  }

  trackStarted(value: unknown): void {
    this.track(value, true);
  }

  trackCompleted(value: unknown): void {
    this.track(value, false);
  }

  parentAgentStarted(): void {
    this.parentRunGeneration += 1;
    this.parentAgentBusy = true;
    if (this.awaitingTriggeredParentRun && this.parentRunGeneration > this.triggerAfterGeneration) {
      this.triggeredParentRunStarted = true;
      this.clearNoFollowupTimer();
    }
  }

  settle(payload: NotifyPayload): void {
    this.parentAgentBusy = false;
    this.pendingNotification = payload;
    if (this.awaitingTriggeredParentRun) {
      if (!this.triggeredParentRunStarted) {
        this.scheduleNoFollowupCheck();
        return;
      }
      this.awaitingTriggeredParentRun = false;
      this.triggeredParentRunStarted = false;
    }
    this.flush();
  }

  /** Reconcile against pi-subagents' current-session RPC status snapshot. */
  reconcileStatus(activeRunIds: readonly string[] | undefined): void {
    if (activeRunIds) {
      this.activeRuns = new Set(activeRunIds);
    }
    for (const change of this.statusSyncChanges ?? []) {
      if (change.active) {
        this.activeRuns.add(change.id);
      } else {
        this.activeRuns.delete(change.id);
        if (change.triggerParentRun) this.markParentRunExpected();
      }
    }
    this.finishStatusSync();
  }

  private track(value: unknown, active: boolean): void {
    if (!isRecord(value) || value.sessionId !== this.sessionId) return;
    const id = typeof value.id === "string" ? value.id : value.runId;
    if (typeof id !== "string" || id.length === 0) return;

    const triggerParentRun = !active && value.triggerTurn !== false;
    if (active) {
      this.activeRuns.add(id);
    } else {
      this.activeRuns.delete(id);
      if (triggerParentRun) this.markParentRunExpected();
    }
    this.statusSyncChanges?.push({ id, active, triggerParentRun });
    this.flush();
    this.scheduleNoFollowupCheck();
  }

  parentAgentStopped(): void {
    this.parentAgentBusy = false;
    this.flush();
    this.scheduleNoFollowupCheck();
  }

  private markParentRunExpected(): void {
    this.awaitingTriggeredParentRun = true;
    this.triggeredParentRunStarted = false;
    this.triggerAfterGeneration = this.parentRunGeneration;
    this.clearNoFollowupTimer();
  }

  private finishStatusSync(): void {
    this.statusSyncPending = false;
    this.statusSyncChanges = undefined;
    this.flush();
    this.scheduleNoFollowupCheck();
  }

  private scheduleNoFollowupCheck(): void {
    if (
      !this.awaitingTriggeredParentRun ||
      this.triggeredParentRunStarted ||
      this.parentAgentBusy ||
      this.activeRuns.size > 0 ||
      this.statusSyncPending ||
      !this.pendingNotification ||
      this.noFollowupTimer
    ) {
      return;
    }

    this.noFollowupTimer = setTimeout(() => {
      this.noFollowupTimer = undefined;
      if (
        !this.awaitingTriggeredParentRun ||
        this.triggeredParentRunStarted ||
        this.parentAgentBusy ||
        this.activeRuns.size > 0 ||
        this.statusSyncPending
      ) {
        this.scheduleNoFollowupCheck();
        return;
      }
      this.awaitingTriggeredParentRun = false;
      this.triggeredParentRunStarted = false;
      this.flush();
    }, this.noFollowupGraceMs);
  }

  private clearNoFollowupTimer(): void {
    if (!this.noFollowupTimer) return;
    clearTimeout(this.noFollowupTimer);
    this.noFollowupTimer = undefined;
  }

  private flush(): void {
    if (
      this.activeRuns.size > 0 ||
      this.statusSyncPending ||
      this.awaitingTriggeredParentRun ||
      this.parentAgentBusy ||
      !this.pendingNotification
    ) {
      return;
    }
    const payload = this.pendingNotification;
    this.pendingNotification = undefined;
    this.notify(payload);
  }
}

export function activeSubagentIdsFromRpcReply(value: unknown): string[] | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return undefined;
  const snapshot = value.data.asyncSnapshot;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.runs)) return undefined;

  return snapshot.runs.flatMap((run) => {
    if (!isRecord(run) || (run.state !== "running" && run.state !== "queued")) return [];
    return typeof run.id === "string" && run.id.length > 0 ? [run.id] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
