import assert from "node:assert/strict";
import test from "node:test";
import mediaKeys from "../index.ts";

function setup(mode = "tui") {
  const handlers = new Map<string, Function>();
  const listeners = new Set<(data: string) => unknown>();
  const pi = { on: (event: string, handler: Function) => handlers.set(event, handler) };
  mediaKeys(pi as unknown as Parameters<typeof mediaKeys>[0]);
  const start = (nextMode = mode) => handlers.get("session_start")!(undefined, {
    mode: nextMode,
    ui: {
      onTerminalInput: (handler: (data: string) => unknown) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
  });
  start();
  return {
    listeners,
    start,
    shutdown: () => handlers.get("session_shutdown")!(),
    input: (data: string) => [...listeners][0](data),
  };
}

for (const code of [57430, 57435, 57436, 57438, 57439]) {
  test(`consumes media key ${code} with press/repeat/release variants`, () => {
    const runtime = setup();
    for (const suffix of ["u", ";1u", ";1:1u", ";1:2u", ";1:3u", ";5:1u"]) {
      assert.deepEqual(runtime.input(`\x1b[${code}${suffix}`), { consume: true });
    }
  });
}

test("preserves unrelated keyboard input and Unicode", () => {
  const runtime = setup();
  for (const input of ["hello", "🎵", "\r", "\x1b[A", "\x1b[97u", "\x1b[57358u"]) {
    assert.equal(runtime.input(input), undefined);
  }
});

test("filters multiple events without discarding surrounding input", () => {
  const runtime = setup();
  assert.deepEqual(
    runtime.input("a\x1b[57439ub\x1b[57435;1:3uc"),
    { data: "abc" },
  );
  assert.deepEqual(
    runtime.input("\x1b[57439u\x1b[57439;1:3u"),
    { consume: true },
  );
});

test("preserves bracketed paste content", () => {
  assert.equal(setup().input("\x1b[200~example \x1b[57439u\x1b[201~"), undefined);
});

test("does not register listeners outside the TUI", () => {
  for (const mode of ["rpc", "json", "print"]) {
    assert.equal(setup(mode).listeners.size, 0);
  }
});

test("cleans up on restart and shutdown", () => {
  const runtime = setup();
  const first = [...runtime.listeners][0];
  runtime.start();
  assert.equal(runtime.listeners.size, 1);
  assert.equal(runtime.listeners.has(first), false);
  runtime.shutdown();
  runtime.shutdown();
  assert.equal(runtime.listeners.size, 0);
  runtime.start();
  assert.equal(runtime.listeners.size, 1);
  runtime.start("rpc");
  assert.equal(runtime.listeners.size, 0);
});
