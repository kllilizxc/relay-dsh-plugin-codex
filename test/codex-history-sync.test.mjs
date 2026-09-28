import assert from "node:assert/strict";
import test from "node:test";

import { CodexHistorySynchronizer } from "../codex-history-sync.mjs";

test("history synchronizer ignores native and incomplete imported bindings", async () => {
  let calls = 0;
  const synchronizer = new CodexHistorySynchronizer({
    adapter: adapter({ bindingMode: "native", importState: null }),
    target: { async sync() { calls += 1; } },
  });
  assert.deepEqual(await synchronizer.syncSession("native-session"), noOp());

  synchronizer.adapter = adapter({ bindingMode: "imported", importState: "hydrated" });
  assert.deepEqual(await synchronizer.syncSession("incomplete-import"), noOp());
  assert.equal(calls, 0);
});

test("history synchronizer coalesces one imported Session and retries after completion", async () => {
  let calls = 0;
  let release;
  const target = {
    sync(binding, ownedTurnIds) {
      calls += 1;
      assert.equal(binding.threadId, "codex-thread");
      assert.deepEqual([...ownedTurnIds], ["dsh-turn"]);
      return new Promise(resolve => { release = () => resolve(result()); });
    },
  };
  const synchronizer = new CodexHistorySynchronizer({
    adapter: adapter({ bindingMode: "imported", importState: "committed" }),
    target,
  });
  const first = synchronizer.syncSession("imported-session");
  const second = synchronizer.syncSession("imported-session");
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { status: "synced", ...result() });
  assert.deepEqual(await second, { status: "synced", ...result() });

  const third = synchronizer.syncSession("imported-session");
  assert.equal(calls, 2);
  release();
  await third;
});

function adapter(binding) {
  return {
    bindingForSession: sessionId => ({
      sessionId,
      threadId: "codex-thread",
      config: {},
      ...binding,
    }),
    ownedTurnIdsForSession: () => new Set(["dsh-turn"]),
  };
}

function noOp() {
  return { status: "not-imported", projectedMessages: 0, projectedTurns: 0, skippedItems: 0 };
}

function result() {
  return { projectedMessages: 2, projectedTurns: 1, skippedItems: 0 };
}
