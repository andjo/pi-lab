import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import notify from "../index.js";

type EventHandler = (event: any, ctx: any) => Promise<void> | void;
type BusHandler = (payload: any) => void;

function setup(config?: unknown, env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-notify-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-notify-cwd-"));
  const sessionId = "/tmp/pi-notify-session.json";
  if (config) {
    mkdirSync(join(cwd, ".pi", "pi-lab"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pi-lab", "notify.json"), JSON.stringify(config), "utf8");
  }

  const eventHandlers: Record<string, EventHandler> = {};
  const busHandlers: Record<string, BusHandler[]> = {};
  const sent: Array<{ title: string; message: string }> = [];
  const tmuxAlerts: string[] = [];
  const scripts: unknown[] = [];
  const warnings: string[] = [];
  let subagentToolAvailable = false;

  const pi = {
    getAllTools() {
      return subagentToolAvailable ? [{ name: "subagent" }] : [];
    },
    on(name: string, handler: EventHandler) {
      eventHandlers[name] = handler;
    },
    events: {
      on(name: string, handler: BusHandler) {
        busHandlers[name] ??= [];
        busHandlers[name].push(handler);
        return () => {
          busHandlers[name] = busHandlers[name].filter((registered) => registered !== handler);
        };
      },
      emit(name: string, payload: any) {
        for (const handler of [...(busHandlers[name] ?? [])]) handler(payload);
      },
    },
  };

  notify(pi as any, {
    home,
    env,
    sendNotification(title, message) {
      sent.push({ title, message });
    },
    sendTmuxAlert() {
      tmuxAlerts.push("alert");
    },
    runScript(_script, payload) {
      scripts.push(payload);
    },
    warn(message) {
      warnings.push(message);
    },
  });

  return {
    cwd,
    sent,
    tmuxAlerts,
    scripts,
    warnings,
    async start() {
      await eventHandlers.session_start({ type: "session_start" }, {
        cwd,
        sessionManager: {
          getSessionFile: () => sessionId,
          getSessionId: () => "session-1",
        },
      });
    },
    async agentSettled() {
      await eventHandlers.agent_settled({ type: "agent_settled", messages: [] }, { cwd });
    },
    agentStarted() {
      eventHandlers.agent_start({ type: "agent_start" }, { cwd });
    },
    agentStopped() {
      eventHandlers.agent_end({ type: "agent_end" }, { cwd });
    },
    permissionAsk(toolName = "bash", toolCallId = "call-1") {
      for (const handler of busHandlers["permissions:ask"] ?? []) handler({ toolName, toolCallId, rule: {}, options: [] });
    },
    subagentStarted(id: string, sessionId = "/tmp/pi-notify-session.json") {
      for (const handler of busHandlers["subagent:async-started"] ?? []) handler({ id, sessionId });
    },
    subagentCompleted(id: string, sessionId = "/tmp/pi-notify-session.json", triggerTurn = false) {
      for (const handler of busHandlers["subagent:async-complete"] ?? []) handler({ id, sessionId, triggerTurn });
    },
    subagentRpcReady() {
      pi.events.emit("subagents:rpc:v1:ready", {});
    },
    enableSubagentTool() {
      subagentToolAvailable = true;
    },
    async shutdown() {
      await eventHandlers.session_shutdown({ type: "session_shutdown" }, { cwd });
    },
    respondWithActiveRuns(ids: string[]) {
      pi.events.on("subagents:rpc:v1:request", (request) => {
        pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          requestId: request.requestId,
          success: true,
          data: { asyncSnapshot: { runs: ids.map((id) => ({ id, state: "running" })) } },
        });
      });
    },
    onStatusRequest(handler: (reply: (ids: string[]) => void) => void) {
      pi.events.on("subagents:rpc:v1:request", (request) => {
        handler((ids) => pi.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          requestId: request.requestId,
          success: true,
          data: { asyncSnapshot: { runs: ids.map((id) => ({ id, state: "running" })) } },
        }));
      });
    },
  };
}

test("agent_settled sends fixed default notification", async () => {
  const app = setup();
  await app.start();

  await app.agentSettled();

  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
});

test("permissions:ask sends fixed default notification with tool name", async () => {
  const app = setup();
  await app.start();

  app.permissionAsk("edit", "edit-call");

  assert.deepEqual(app.sent, [{ title: "Pi", message: "Permission required: edit" }]);
});

test("agent_settled waits until all active async subagents have completed", async () => {
  const app = setup();
  await app.start();

  app.subagentStarted("run-1");
  app.subagentStarted("run-2");
  await app.agentSettled();
  assert.deepEqual(app.sent, []);

  app.subagentCompleted("run-1");
  assert.deepEqual(app.sent, []);

  app.subagentCompleted("run-2");
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
});

test("restores active subagents from pi-subagents status after session start", async () => {
  const app = setup();
  app.respondWithActiveRuns(["restored-run"]);
  await app.start();
  app.subagentRpcReady();

  await app.agentSettled();
  assert.deepEqual(app.sent, []);

  app.subagentCompleted("restored-run");
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
});

test("rechecks status at settle for runs whose start event was missed", async () => {
  const app = setup();
  const activeRuns: string[] = [];
  app.respondWithActiveRuns(activeRuns);
  await app.start();
  app.subagentRpcReady();

  activeRuns.push("missed-run");
  await app.agentSettled();
  assert.deepEqual(app.sent, []);

  activeRuns.length = 0;
  app.subagentCompleted("missed-run");
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
  await app.shutdown();
});

test("detects pi-subagents even when its RPC ready event was missed", async () => {
  const app = setup();
  app.enableSubagentTool();
  app.respondWithActiveRuns(["already-running"]);
  await app.start();

  await app.agentSettled();
  assert.deepEqual(app.sent, []);

  app.subagentCompleted("already-running");
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
  await app.shutdown();
});

test("reconciles missed completion events while a notification is held", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = setup();
  const activeRuns = ["run-1", "run-2"];
  app.respondWithActiveRuns(activeRuns);
  await app.start();
  app.subagentRpcReady();
  await app.agentSettled();
  assert.deepEqual(app.sent, []);

  activeRuns.splice(0, 1);
  t.mock.timers.tick(5000);
  assert.deepEqual(app.sent, []);

  activeRuns.length = 0;
  t.mock.timers.tick(5000);
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
  t.mock.timers.tick(10000);
  assert.equal(app.sent.length, 1);
  await app.shutdown();
});

test("holds notifications during an asynchronous status check and replays new starts", async () => {
  const app = setup();
  let reply: ((ids: string[]) => void) | undefined;
  app.enableSubagentTool();
  app.onStatusRequest((respond) => { reply = respond; });
  await app.start();

  await app.agentSettled();
  assert.deepEqual(app.sent, []);
  app.subagentStarted("started-during-check");
  reply!([]);
  assert.deepEqual(app.sent, []);

  app.subagentCompleted("started-during-check");
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
  await app.shutdown();
});

test("settling replaces an older in-flight status query rather than trusting its snapshot", async () => {
  const app = setup();
  const replies: Array<(ids: string[]) => void> = [];
  app.onStatusRequest((reply) => { replies.push(reply); });
  await app.start();
  app.subagentRpcReady();
  assert.equal(replies.length, 1);

  await app.agentSettled();
  assert.equal(replies.length, 2);
  replies[0]([]);
  assert.deepEqual(app.sent, []);
  replies[1](["launched-after-startup-query"]);
  assert.deepEqual(app.sent, []);

  app.subagentCompleted("launched-after-startup-query");
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
  await app.shutdown();
});

test("does not notify on a status timeout and retries until all runs finish", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = setup();
  app.enableSubagentTool();
  await app.start();
  await app.agentSettled();

  t.mock.timers.tick(5000);
  assert.deepEqual(app.sent, []);
  assert.equal(app.warnings.length, 1);

  const activeRuns = ["still-running"];
  app.respondWithActiveRuns(activeRuns);
  t.mock.timers.tick(5000);
  assert.deepEqual(app.sent, []);

  activeRuns.length = 0;
  t.mock.timers.tick(5000);
  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
  await app.shutdown();
});

test("shutdown cancels polling and ignores late status replies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const app = setup();
  let reply: ((ids: string[]) => void) | undefined;
  let requests = 0;
  app.enableSubagentTool();
  app.onStatusRequest((respond) => { requests += 1; reply = respond; });
  await app.start();
  await app.agentSettled();
  await app.shutdown();

  reply!([]);
  app.subagentRpcReady();
  t.mock.timers.tick(20000);
  assert.deepEqual(app.sent, []);
  assert.equal(requests, 1);
});

test("waits for the parent's completion turn after a subagent completion wake", async () => {
  const app = setup();
  await app.start();

  app.subagentStarted("run-1");
  await app.agentSettled();
  app.subagentCompleted("run-1", "/tmp/pi-notify-session.json", true);
  assert.deepEqual(app.sent, []);

  app.agentStarted();
  assert.deepEqual(app.sent, []);
  await app.agentSettled();

  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
});

test("subagents from another session do not delay settled notifications", async () => {
  const app = setup();
  await app.start();

  app.subagentStarted("other-run", "different-session");
  await app.agentSettled();

  assert.deepEqual(app.sent, [{ title: "Pi", message: "Ready for input" }]);
});

test("permission notifications are not delayed by running subagents", async () => {
  const app = setup();
  await app.start();

  app.subagentStarted("run-1");
  app.permissionAsk("edit");

  assert.deepEqual(app.sent, [{ title: "Pi", message: "Permission required: edit" }]);
});

test("notifications alert the tmux window", async () => {
  const app = setup(undefined, { TMUX: "/tmp/tmux-1000/default,1,0" });
  await app.start();

  await app.agentSettled();
  app.permissionAsk();

  assert.equal(app.tmuxAlerts.length, 2);
});

test("notifications do not alert outside tmux", async () => {
  const app = setup(undefined, {});
  await app.start();

  await app.agentSettled();

  assert.equal(app.tmuxAlerts.length, 0);
});

test("enable false disables default notifications but keeps script hook", async () => {
  const app = setup({ notify: { enable: false, script: "./notify.sh" } }, { TMUX: "/tmp/tmux-1000/default,1,0" });
  await app.start();

  await app.agentSettled();
  app.permissionAsk("bash", "ask-call");

  assert.deepEqual(app.sent, []);
  assert.equal(app.tmuxAlerts.length, 0);
  assert.equal(app.scripts.length, 2);
  assert.deepEqual(
    app.scripts.map((payload: any) => ({
      event: payload.event,
      title: payload.title,
      message: payload.message,
      cwd: payload.cwd,
      pid: payload.pid,
      notificationIdPrefix: String(payload.notificationId).replace(/-\d+$/, ""),
    })),
    [
      {
        event: "agent_settled",
        title: "Pi",
        message: "Ready for input",
        cwd: app.cwd,
        pid: process.pid,
        notificationIdPrefix: "pi-agent-settled",
      },
      {
        event: "permission_ask",
        title: "Pi",
        message: "Permission required: bash",
        cwd: app.cwd,
        pid: process.pid,
        notificationIdPrefix: "pi-permission-ask",
      },
    ],
  );
  for (const payload of app.scripts as any[]) {
    assert.equal("toolName" in payload, false);
    assert.equal("toolCallId" in payload, false);
    assert.equal(typeof payload.timestamp, "number");
    assert.equal(typeof payload.terminal, "object");
  }
});

test("PI_INSIDE_FROSTPI=1 suppresses built-in, tmux, and script notifications", async () => {
  const app = setup(
    { notify: { script: "./notify.sh" } },
    { PI_INSIDE_FROSTPI: "1", TMUX: "/tmp/tmux-1000/default,1,0" },
  );
  await app.start();

  await app.agentSettled();
  app.permissionAsk();

  assert.deepEqual(app.sent, []);
  assert.deepEqual(app.tmuxAlerts, []);
  assert.deepEqual(app.scripts, []);
});

test("script payload includes terminal context", async () => {
  const app = setup({ notify: { script: "./notify.sh" } }, process.env);
  await app.start();

  await app.agentSettled();

  const payload = app.scripts[0] as any;
  assert.deepEqual(payload.terminal, {
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    kittyWindowId: process.env.KITTY_WINDOW_ID,
    weztermPane: process.env.WEZTERM_PANE,
    wtSession: process.env.WT_SESSION,
    tmux: process.env.TMUX,
  });
});

for (const hasUI of [false, true]) {
  test(`script hook errors use ${hasUI ? "UI warnings" : "console fallback"} and do not stop notifications`, async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-notify-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-notify-cwd-"));
    mkdirSync(join(cwd, ".pi", "pi-lab"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pi-lab", "notify.json"), JSON.stringify({ notify: { script: "./notify.sh" } }), "utf8");

    const eventHandlers: Record<string, EventHandler> = {};
    const sent: Array<{ title: string; message: string }> = [];
    const warnings: string[] = [];
    const uiWarnings: Array<{ message: string; type: string }> = [];
    const pi = {
      on(name: string, handler: EventHandler) {
        eventHandlers[name] = handler;
      },
      events: { on() {} },
    };
    notify(pi as any, {
      home,
      env: {},
      sendNotification(title, message) {
        sent.push({ title, message });
      },
      runScript() {
        throw new Error("boom");
      },
      warn(message) {
        warnings.push(message);
      },
    });
    await eventHandlers.session_start({ type: "session_start" }, {
      cwd,
      hasUI,
      ui: {
        notify(message: string, type: string) {
          uiWarnings.push({ message, type });
        },
      },
      sessionManager: {
        getSessionFile: () => "/tmp/pi-notify-session.json",
        getSessionId: () => "session-1",
      },
    });

    await eventHandlers.agent_settled({ type: "agent_settled", messages: [] }, { cwd });

    assert.deepEqual(sent, [{ title: "Pi", message: "Ready for input" }]);
    assert.deepEqual(warnings, hasUI ? [] : ["notify script failed: boom"]);
    assert.deepEqual(uiWarnings, hasUI ? [{ message: "notify script failed: boom", type: "warning" }] : []);
  });
}
