import type { NotifyPayload } from "./script.js";

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";

type RunChange = { id: string; active: boolean };

export class SubagentNotificationGate {
  private sessionId: string | undefined;
  private activeRuns = new Set<string>();
  private pendingNotification: NotifyPayload | undefined;
  private statusSyncPending = false;
  private statusSyncChanges: RunChange[] | undefined;

  constructor(private readonly notify: (payload: NotifyPayload) => void) {}

  reset(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.activeRuns.clear();
    this.pendingNotification = undefined;
    this.statusSyncPending = false;
    this.statusSyncChanges = undefined;
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

  settle(payload: NotifyPayload): void {
    if (this.activeRuns.size > 0 || this.statusSyncPending) {
      this.pendingNotification = payload;
      return;
    }
    this.notify(payload);
  }

  /** Reconcile against pi-subagents' current-session RPC status snapshot. */
  reconcileStatus(activeRunIds: readonly string[] | undefined): void {
    if (activeRunIds) {
      this.activeRuns = new Set(activeRunIds);
    }
    for (const change of this.statusSyncChanges ?? []) {
      if (change.active) this.activeRuns.add(change.id);
      else this.activeRuns.delete(change.id);
    }
    this.finishStatusSync();
  }

  private track(value: unknown, active: boolean): void {
    if (!isRecord(value) || value.sessionId !== this.sessionId) return;
    const id = typeof value.id === "string" ? value.id : value.runId;
    if (typeof id !== "string" || id.length === 0) return;

    if (active) this.activeRuns.add(id);
    else this.activeRuns.delete(id);
    this.statusSyncChanges?.push({ id, active });
    this.flush();
  }

  private finishStatusSync(): void {
    this.statusSyncPending = false;
    this.statusSyncChanges = undefined;
    this.flush();
  }

  private flush(): void {
    if (this.activeRuns.size > 0 || this.statusSyncPending || !this.pendingNotification) return;
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
