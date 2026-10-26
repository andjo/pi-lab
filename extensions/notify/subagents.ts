import type { NotifyPayload } from "./script.js";

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

export type SubagentActivity = { activeRunIds: string[]; hasAdditionalActivity: boolean };

type RunChange = { id: string; active: boolean };

export class SubagentNotificationGate {
  private sessionId: string | undefined;
  private activeRuns = new Set<string>();
  private hasAdditionalActivity = false;
  private pendingNotification: NotifyPayload | undefined;
  private statusSyncPending = false;
  private statusSyncChanges: RunChange[] | undefined;
  private awaitingTriggeredParentRun = false;
  private explicitParentWakePending = false;
  private pendingCompletionIds = new Set<string>();
  private seenCompletionIds = new Set<string>();
  private parentAborted = false;
  private triggeredParentRunStarted = false;
  private triggerAfterGeneration = 0;
  private parentRunGeneration = 0;
  private parentAgentBusy = false;
  private noFollowupTimer: NodeJS.Timeout | undefined;
  private deliveryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly notify: (payload: NotifyPayload) => void,
    private readonly noFollowupGraceMs = 1000,
    private readonly canNotify: () => boolean = () => true,
    private readonly deliveryDelayMs = 0,
  ) {}

  reset(sessionId: string | undefined): void {
    this.clearNoFollowupTimer();
    this.clearDeliveryTimer();
    this.sessionId = sessionId;
    this.activeRuns.clear();
    this.hasAdditionalActivity = false;
    this.pendingNotification = undefined;
    this.statusSyncPending = false;
    this.statusSyncChanges = undefined;
    this.awaitingTriggeredParentRun = false;
    this.explicitParentWakePending = false;
    this.pendingCompletionIds.clear();
    this.seenCompletionIds.clear();
    this.parentAborted = false;
    this.triggeredParentRunStarted = false;
    this.triggerAfterGeneration = 0;
    this.parentRunGeneration = 0;
    this.parentAgentBusy = false;
  }

  get hasPendingNotification(): boolean {
    return this.pendingNotification !== undefined;
  }

  beginStatusSync(): void {
    this.clearDeliveryTimer();
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
    // Readiness from an earlier turn is stale once the parent resumes. Only
    // the new turn's agent_settled event may queue another notification.
    this.pendingNotification = undefined;
    this.clearNoFollowupTimer();
    this.clearDeliveryTimer();
    if (!this.parentAgentBusy) {
      this.parentRunGeneration += 1;
      this.seenCompletionIds.clear();
      this.pendingCompletionIds.clear();
      this.explicitParentWakePending = false;
    }
    this.parentAgentBusy = true;
    this.parentAborted = false;
    if (this.awaitingTriggeredParentRun && this.parentRunGeneration > this.triggerAfterGeneration) {
      this.triggeredParentRunStarted = true;
      this.clearNoFollowupTimer();
    }
  }

  parentCompletionMessageStarted(runIds: readonly string[]): void {
    if (!this.parentAgentBusy) return;
    for (const id of runIds) {
      this.seenCompletionIds.add(id);
      this.pendingCompletionIds.delete(id);
    }
    this.explicitParentWakePending = this.pendingCompletionIds.size > 0;
    if (this.awaitingTriggeredParentRun && !this.explicitParentWakePending) {
      this.triggeredParentRunStarted = true;
    }
  }

  settle(payload: NotifyPayload, aborted = false): void {
    this.parentAgentBusy = false;
    this.parentAborted = aborted;
    this.pendingNotification = payload;
    if (aborted) {
      // pi-subagents appends held results without resuming a user-aborted turn.
      this.awaitingTriggeredParentRun = false;
      this.explicitParentWakePending = false;
      this.pendingCompletionIds.clear();
      this.triggeredParentRunStarted = false;
      this.clearNoFollowupTimer();
    }
    if (this.awaitingTriggeredParentRun) {
      if (!this.triggeredParentRunStarted || this.explicitParentWakePending) {
        this.scheduleNoFollowupCheck();
        return;
      }
      this.awaitingTriggeredParentRun = false;
      this.explicitParentWakePending = false;
      this.triggeredParentRunStarted = false;
    }
    this.flush();
  }

  /** Reconcile against pi-subagents' current-session RPC status snapshot. */
  reconcileStatus(activeRunIds: readonly string[], hasAdditionalActivity = false): void {
    this.activeRuns = new Set(activeRunIds);
    // Foreground work and nested children need not emit a matching root
    // completion event. Only another status snapshot can clear this latch.
    this.hasAdditionalActivity = hasAdditionalActivity;
    for (const change of this.statusSyncChanges ?? []) {
      if (change.active) {
        this.activeRuns.add(change.id);
      } else {
        this.activeRuns.delete(change.id);
      }
    }
    this.finishStatusSync();
  }

  private track(value: unknown, active: boolean): void {
    if (!this.sessionId || !isRecord(value) || value.sessionId !== this.sessionId) return;
    const id = typeof value.id === "string" ? value.id : value.runId;
    if (typeof id !== "string" || id.length === 0) return;

    this.clearDeliveryTimer();
    const triggerParentRun = !active && value.triggerTurn !== false;
    if (active) {
      this.activeRuns.add(id);
    } else {
      this.activeRuns.delete(id);
      if (triggerParentRun && !this.parentAborted) this.markParentRunExpected(id, value.triggerTurn === true);
    }
    this.statusSyncChanges?.push({ id, active });
    this.flush();
    this.scheduleNoFollowupCheck();
  }

  parentAgentStopped(): void {
    this.parentAgentBusy = false;
    this.flush();
    this.scheduleNoFollowupCheck();
  }

  private markParentRunExpected(id: string, explicit: boolean): void {
    this.awaitingTriggeredParentRun = true;
    // Explicit wakes can be batched even while the parent is busy. Count the
    // current run only once its matching completion message was observed.
    if (explicit && !(this.parentAgentBusy && this.seenCompletionIds.has(id))) this.pendingCompletionIds.add(id);
    this.explicitParentWakePending = this.pendingCompletionIds.size > 0;
    this.triggeredParentRunStarted = this.parentAgentBusy && !this.explicitParentWakePending;
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
      this.explicitParentWakePending ||
      this.triggeredParentRunStarted ||
      this.parentAgentBusy ||
      this.activeRuns.size > 0 ||
      this.hasAdditionalActivity ||
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
        this.hasAdditionalActivity ||
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

  private clearDeliveryTimer(): void {
    if (!this.deliveryTimer) return;
    clearTimeout(this.deliveryTimer);
    this.deliveryTimer = undefined;
  }

  private canFlush(): boolean {
    return this.activeRuns.size === 0 &&
      !this.hasAdditionalActivity &&
      !this.statusSyncPending &&
      !this.awaitingTriggeredParentRun &&
      !this.parentAgentBusy &&
      this.pendingNotification !== undefined &&
      this.canNotify();
  }

  private flush(): void {
    if (!this.canFlush()) return;
    if (this.deliveryDelayMs > 0) {
      if (!this.deliveryTimer) {
        // Let later agent_settled handlers and Pi's deferred wake actions run.
        // Activity during this quiet period cancels delivery.
        this.deliveryTimer = setTimeout(() => {
          this.deliveryTimer = undefined;
          if (this.canFlush()) this.sendPending();
        }, this.deliveryDelayMs);
      }
      return;
    }
    this.sendPending();
  }

  private sendPending(): void {
    const payload = this.pendingNotification!;
    this.pendingNotification = undefined;
    this.notify(payload);
  }
}

export function subagentActivityFromRpcReply(value: unknown): SubagentActivity | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return undefined;
  const snapshot = value.data.asyncSnapshot;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.runs)) return undefined;

  const fleet = value.data.fleet;
  // Fleet counts include foreground controls and work omitted from the bounded
  // async projection. Do not mistake an empty async list for an empty fleet.
  let hasAdditionalActivity = false;
  if (fleet !== undefined) {
    if (!isRecord(fleet) || typeof fleet.totalActive !== "number" ||
      !Number.isSafeInteger(fleet.totalActive) || fleet.totalActive < 0) return undefined;
    hasAdditionalActivity = fleet.totalActive > 0;
  }
  if (fleet === undefined && isRecord(snapshot.omitted) &&
    ((typeof snapshot.omitted.runs === "number" && snapshot.omitted.runs > 0) || snapshot.omitted.byteLimitExceeded === true)) {
    hasAdditionalActivity = true;
  }
  const activeRunIds: string[] = [];
  const visit = (node: unknown, root: boolean): boolean => {
    if (!isRecord(node) || typeof node.id !== "string" || !node.id || typeof node.state !== "string") return false;
    const active = node.state === "running" || node.state === "queued" || node.state === "pending";
    if (!active && !["complete", "failed", "partial", "paused", "stopped", "rejected"].includes(node.state)) return false;
    if (active) {
      if (root) activeRunIds.push(node.id);
      else hasAdditionalActivity = true;
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children) || !node.children.every((child) => visit(child, false))) return false;
    }
    return true;
  };
  if (!snapshot.runs.every((run) => visit(run, true))) return undefined;
  return { activeRunIds, hasAdditionalActivity };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
