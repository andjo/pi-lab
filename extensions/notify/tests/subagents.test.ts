import assert from "node:assert/strict";
import test from "node:test";

import { subagentActivityFromRpcReply, SubagentNotificationGate } from "../subagents.js";
import type { NotifyPayload } from "../script.js";

function payload(): NotifyPayload {
  return {
    event: "agent_settled",
    notificationId: "pi-agent-settled-1",
    title: "Pi",
    message: "Ready for input",
    timestamp: 1,
    cwd: "/tmp/project",
    pid: 1,
    terminal: {},
  };
}

test("holds settled notification until every active subagent completes", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.trackStarted({ id: "run-1", sessionId: "session-1" });
  gate.trackStarted({ id: "run-2", sessionId: "session-1" });

  gate.settle(payload());
  gate.trackCompleted({ id: "run-1", sessionId: "session-1", triggerTurn: false });
  assert.deepEqual(sent, []);

  gate.trackCompleted({ id: "run-2", sessionId: "session-1", triggerTurn: false });
  assert.deepEqual(sent, [payload()]);
});

test("status reconciliation restores in-flight runs and reapplies events seen during lookup", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.beginStatusSync();
  gate.trackStarted({ id: "started-during-query", sessionId: "session-1" });
  gate.settle(payload());

  gate.reconcileStatus(["already-running"]);
  gate.trackCompleted({ id: "already-running", sessionId: "session-1", triggerTurn: false });
  assert.deepEqual(sent, []);

  gate.trackCompleted({ id: "started-during-query", sessionId: "session-1", triggerTurn: false });
  assert.deepEqual(sent, [payload()]);
});

test("a busy parent can consume a completion without a separate follow-up run", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification), 10);
  gate.reset("session-1");
  gate.parentAgentStarted();
  gate.trackStarted({ id: "run-1", sessionId: "session-1" });
  gate.trackCompleted({ id: "run-1", sessionId: "session-1", triggerTurn: true });
  gate.parentCompletionMessageStarted(["run-1"]);
  gate.parentAgentStopped();

  gate.settle(payload());
  assert.deepEqual(sent, [payload()]);
});

test("legacy completion events without an explicit wake flag retain their grace period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification), 10);
  gate.reset("session-1");
  gate.trackStarted({ id: "child", sessionId: "session-1" });
  gate.settle(payload());
  gate.trackCompleted({ id: "child", sessionId: "session-1" });
  t.mock.timers.tick(9);
  assert.deepEqual(sent, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sent, [payload()]);
});

test("completion messages observed before lifecycle events still count as consumed", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.parentAgentStarted();
  gate.parentCompletionMessageStarted(["child"]);
  gate.trackCompleted({ id: "child", sessionId: "session-1", triggerTurn: true });
  gate.settle(payload());
  assert.deepEqual(sent, [payload()]);
});

test("waits for the agent run triggered by a completion before flushing", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.trackStarted({ id: "run-1", sessionId: "session-1" });
  gate.settle(payload());
  gate.trackCompleted({ id: "run-1", sessionId: "session-1", triggerTurn: true });

  assert.deepEqual(sent, []);
  gate.settle(payload());
  assert.deepEqual(sent, []);

  gate.parentAgentStarted();
  gate.settle({ ...payload(), notificationId: "pi-agent-settled-2", timestamp: 2 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].notificationId, "pi-agent-settled-2");
});

test("a resumed parent discards readiness from its previous settled turn", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.trackStarted({ id: "run-1", sessionId: "session-1" });
  gate.settle(payload());

  gate.parentAgentStarted();
  gate.trackCompleted({ id: "run-1", sessionId: "session-1", triggerTurn: false });
  gate.parentAgentStopped();
  assert.deepEqual(sent, []);

  // The new turn can launch more work before it settles.
  gate.trackStarted({ id: "run-2", sessionId: "session-1" });
  const latest = { ...payload(), notificationId: "pi-agent-settled-2", timestamp: 2 };
  gate.settle(latest);
  assert.deepEqual(sent, []);
  gate.trackCompleted({ id: "run-2", sessionId: "session-1", triggerTurn: false });
  assert.deepEqual(sent, [latest]);
});

test("an aborted parent does not wait for a completion wake that will be held", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.trackStarted({ id: "child", sessionId: "session-1" });
  gate.settle(payload(), true);
  gate.trackCompleted({ id: "child", sessionId: "session-1", triggerTurn: true });
  assert.deepEqual(sent, [payload()]);
});

test("status replay does not invent another wake after the follow-up already settled", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.trackStarted({ id: "child", sessionId: "session-1" });
  gate.settle(payload());
  gate.beginStatusSync();
  gate.trackCompleted({ id: "child", sessionId: "session-1", triggerTurn: true });
  gate.parentAgentStarted();
  gate.settle(payload());
  gate.reconcileStatus([]);
  assert.deepEqual(sent, [payload()]);
});

test("quiet-period delivery rechecks readiness and is cancelled by new children or reset", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: NotifyPayload[] = [];
  let ready = true;
  const gate = new SubagentNotificationGate((notification) => sent.push(notification), 1000, () => ready, 100);
  gate.reset("session-1");
  gate.settle(payload());
  ready = false;
  t.mock.timers.tick(100);
  assert.deepEqual(sent, []);

  ready = true;
  gate.reconcileStatus([]);
  gate.trackStarted({ id: "child", sessionId: "session-1" });
  t.mock.timers.tick(100);
  assert.deepEqual(sent, []);
  gate.trackCompleted({ id: "child", sessionId: "session-1", triggerTurn: false });
  t.mock.timers.tick(100);
  assert.deepEqual(sent, [payload()]);

  gate.settle(payload());
  gate.reset("session-2");
  t.mock.timers.tick(100);
  assert.equal(sent.length, 1);
});

test("foreground/nested activity cannot be cleared by an unrelated root completion", () => {
  const sent: NotifyPayload[] = [];
  const gate = new SubagentNotificationGate((notification) => sent.push(notification));
  gate.reset("session-1");
  gate.beginStatusSync();
  gate.settle(payload());
  gate.reconcileStatus([], true);
  gate.trackCompleted({ id: "workflow", sessionId: "session-1", triggerTurn: false });
  assert.deepEqual(sent, []);
  gate.reconcileStatus([], false);
  assert.deepEqual(sent, [payload()]);
});

test("bounded or malformed status snapshots do not imply that all work finished", () => {
  const parse = (asyncSnapshot: unknown, fleet?: unknown) => subagentActivityFromRpcReply({
    success: true, data: { asyncSnapshot, ...(fleet === undefined ? {} : { fleet }) },
  });
  assert.deepEqual(parse({ runs: [], omitted: { runs: 3 } }), {
    activeRunIds: [], hasAdditionalActivity: true,
  });
  assert.deepEqual(parse({ runs: [], omitted: { byteLimitExceeded: true } }), {
    activeRunIds: [], hasAdditionalActivity: true,
  });
  assert.deepEqual(parse({ runs: [], omitted: { runs: 3 } }, { totalActive: 2 }), {
    activeRunIds: [], hasAdditionalActivity: true,
  });
  assert.deepEqual(parse({ runs: [], omitted: { runs: 3 } }, { totalActive: 0 }), {
    activeRunIds: [], hasAdditionalActivity: false,
  });
  for (const fleet of [{}, { totalActive: -1 }, { totalActive: "0" }]) {
    assert.equal(parse({ runs: [] }, fleet), undefined);
  }
  for (const run of [{ id: "child" }, { id: "child", state: "unknown" }, { id: "child", state: "complete", children: {} }]) {
    assert.equal(parse({ runs: [run] }), undefined);
  }
});

test("extracts active root runs and additional activity from the subagent status RPC reply", () => {
  assert.deepEqual(subagentActivityFromRpcReply({
    success: true,
    data: {
      asyncSnapshot: {
        runs: [
          { id: "running", state: "running" },
          { id: "queued", state: "queued" },
          { id: "finished", state: "complete" },
        ],
      },
    },
  }), { activeRunIds: ["running", "queued"], hasAdditionalActivity: false });

  assert.equal(subagentActivityFromRpcReply({ success: false }), undefined);
});
