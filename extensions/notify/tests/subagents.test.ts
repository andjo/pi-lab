import assert from "node:assert/strict";
import test from "node:test";

import { activeSubagentIdsFromRpcReply, SubagentNotificationGate } from "../subagents.js";
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
  gate.trackCompleted({ id: "run-1", sessionId: "session-1" });
  assert.deepEqual(sent, []);

  gate.trackCompleted({ id: "run-2", sessionId: "session-1" });
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
  gate.trackCompleted({ id: "already-running", sessionId: "session-1" });
  assert.deepEqual(sent, []);

  gate.trackCompleted({ id: "started-during-query", sessionId: "session-1" });
  assert.deepEqual(sent, [payload()]);
});

test("extracts only active top-level runs from the subagent status RPC reply", () => {
  assert.deepEqual(activeSubagentIdsFromRpcReply({
    success: true,
    data: {
      asyncSnapshot: {
        runs: [
          { id: "running", state: "running" },
          { id: "queued", state: "queued" },
          { id: "finished", state: "complete" },
          { id: "malformed" },
        ],
      },
    },
  }), ["running", "queued"]);

  assert.equal(activeSubagentIdsFromRpcReply({ success: false }), undefined);
});
