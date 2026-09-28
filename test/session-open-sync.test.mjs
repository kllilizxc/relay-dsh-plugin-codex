import assert from "node:assert/strict";
import test from "node:test";

import { CODEX_SYNC_PATH } from "../codex-sync-contract.mjs";
import {
  observeSessionOpen,
  readPersistedDshCurrentSessionId,
  syncOpenedCodexSessionAndRefresh,
  syncOpenedCodexSession,
  writePersistedDshCurrentSessionId,
} from "../src/client/session-open-sync.mjs";

test("Session selection triggers once per open interval and again after leaving", async () => {
  const selection = observable();
  const calls = [];
  const errors = [];
  const dispose = observeSessionOpen(selection, async (sessionId) => {
    calls.push(sessionId);
    if (sessionId === "native-1") throw new Error("sync failed");
  }, error => errors.push(error));

  selection.set("imported-1");
  selection.notify();
  selection.set("native-1");
  selection.set(null);
  selection.set("imported-1");
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, ["imported-1", "native-1", "imported-1"]);
  assert.deepEqual(errors.map(error => error.message), ["sync failed"]);
  dispose();
  selection.set("after-dispose");
  assert.equal(calls.length, 3);
});

test("Session selection falls back to DSH's persisted current Session when current projection is absent", async () => {
  const selection = observable();
  const calls = [];
  const dispose = observeSessionOpen(selection, sessionId => {
    calls.push(sessionId);
  }, console.warn, () => "persisted-imported");

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["persisted-imported"]);
  selection.set("live-session");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["persisted-imported", "live-session"]);
  dispose();
});

test("a transient open-sync failure retries without requiring the user to leave the Session", async () => {
  const selection = observable();
  const calls = [];
  const errors = [];
  const dispose = observeSessionOpen(selection, async sessionId => {
    calls.push(sessionId);
    if (calls.length === 1) throw new Error("temporary sync failure");
  }, error => errors.push(error));

  selection.set("imported-retry");
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(calls, ["imported-retry", "imported-retry"]);
  assert.deepEqual(errors, []);
  dispose();
});

test("a late rebuild result can tell that the user has opened another Session", async () => {
  const selection = observable();
  const pending = new Map();
  const calls = [];
  const dispose = observeSessionOpen(selection, (sessionId, isLatestSelection) => new Promise(resolve => {
    calls.push({ sessionId, isLatestSelection });
    pending.set(sessionId, resolve);
  }));

  selection.set("imported-a");
  selection.set("imported-b");
  assert.equal(calls[0].isLatestSelection(), false);
  assert.equal(calls[1].isLatestSelection(), true);

  pending.get("imported-a")();
  pending.get("imported-b")();
  await new Promise(resolve => setImmediate(resolve));
  dispose();
});

test("an in-flight rebuild remains current across DSH's temporary empty selection", async () => {
  const selection = observable();
  const pending = [];
  const calls = [];
  const dispose = observeSessionOpen(selection, (sessionId, isLatestSelection) => new Promise(resolve => {
    calls.push({ sessionId, isLatestSelection });
    pending.push(resolve);
  }), console.warn, () => null);

  selection.set("imported-gap");
  selection.set(null);
  assert.equal(calls[0].isLatestSelection(), true);
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));

  selection.notify();
  selection.set("imported-gap");
  assert.equal(calls.length, 2);
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  dispose();
});

test("open sync client posts only the Session ID and validates the response", async () => {
  const requests = [];
  const result = await syncOpenedCodexSession("session-1", async (path, init) => {
    requests.push({ path, init });
    return new Response(JSON.stringify({
      status: "synced", projectedMessages: 2, projectedTurns: 1, skippedItems: 0,
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(result.projectedMessages, 2);
  assert.equal(requests[0].path, CODEX_SYNC_PATH);
  assert.deepEqual(JSON.parse(requests[0].init.body), { sessionId: "session-1" });

  await assert.rejects(syncOpenedCodexSession("session-1", async () => new Response(
    JSON.stringify({ message: "sync unavailable" }),
    { status: 500, headers: { "content-type": "application/json" } },
  )), /sync unavailable/);
});

test("open sync refreshes the DSH Session view only when history changed", async () => {
  const refreshed = [];
  const opened = [];
  const changed = await syncOpenedCodexSessionAndRefresh("session-1", () => {
    refreshed.push("changed");
  }, response({
    status: "synced", projectedMessages: 2, projectedTurns: 1, skippedItems: 0,
  }));
  assert.equal(changed.projectedMessages, 2);
  assert.deepEqual(refreshed, ["changed"]);

  await syncOpenedCodexSessionAndRefresh("session-1", () => {
    refreshed.push("empty");
  }, response({
    status: "synced", projectedMessages: 0, projectedTurns: 0, skippedItems: 0,
  }));
  await syncOpenedCodexSessionAndRefresh("session-1", () => {
    refreshed.push("native");
  }, response({
    status: "not-imported", projectedMessages: 0, projectedTurns: 0, skippedItems: 0,
  }));
  await syncOpenedCodexSessionAndRefresh("session-1", () => {
    refreshed.push("model");
  }, response({
    status: "synced",
    projectedMessages: 0,
    projectedTurns: 0,
    skippedItems: 0,
    modelSelectionChanged: true,
  }), sessionId => { opened.push(sessionId); });
  await syncOpenedCodexSessionAndRefresh("session-1", () => {
    refreshed.push("rebuilt");
  }, response({
    status: "synced",
    projectedMessages: 0,
    projectedTurns: 0,
    skippedItems: 0,
    rebuiltSessionId: "session-rebuilt",
  }), sessionId => { opened.push(sessionId); }, sessionId => { opened.push(`persisted:${sessionId}`); });
  assert.deepEqual(refreshed, ["changed", "rebuilt"]);
  assert.deepEqual(opened, ["persisted:session-rebuilt", "session-rebuilt"]);
});

test("rebuilt Session opening retries after refreshing a list that was initially stale", async () => {
  const calls = [];
  let openAttempts = 0;

  await syncOpenedCodexSessionAndRefresh("session-old", async () => {
    calls.push("refresh");
  }, response({
    status: "synced",
    projectedMessages: 0,
    projectedTurns: 0,
    skippedItems: 0,
    rebuiltSessionId: "session-new",
  }), sessionId => {
    calls.push(`open:${sessionId}`);
    openAttempts += 1;
    if (openAttempts === 1) throw new Error("sessions.select: unknown session session-new");
  }, sessionId => {
    calls.push(`persist:${sessionId}`);
  });

  assert.deepEqual(calls, [
    "refresh",
    "persist:session-new",
    "open:session-new",
    "refresh",
    "open:session-new",
  ]);
});

test("a rebuilt Session does not steal selection after the user opens another Session", async () => {
  const calls = [];

  await syncOpenedCodexSessionAndRefresh("session-old", async () => {
    calls.push("refresh");
  }, response({
    status: "synced",
    projectedMessages: 0,
    projectedTurns: 0,
    skippedItems: 0,
    rebuiltSessionId: "session-new",
  }), sessionId => {
    calls.push(`open:${sessionId}`);
  }, sessionId => {
    calls.push(`persist:${sessionId}`);
  }, () => false);

  assert.deepEqual(calls, ["refresh"]);
});

test("DSH current Session persistence helpers tolerate unavailable storage", () => {
  const storage = storageDouble();
  assert.equal(readPersistedDshCurrentSessionId(storage), null);
  writePersistedDshCurrentSessionId("session-1", storage);
  assert.equal(readPersistedDshCurrentSessionId(storage), "session-1");
  storage.setItem("dsh.sessions.current", "{");
  assert.equal(readPersistedDshCurrentSessionId(storage), null);
  assert.doesNotThrow(() => writePersistedDshCurrentSessionId("session-2", null));
});

function observable() {
  let sessionId = null;
  const listeners = new Set();
  return {
    getSnapshot: () => sessionId === null ? {} : { sessionId },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    notify() { for (const listener of listeners) listener(); },
    set(next) { sessionId = next; this.notify(); },
  };
}

function response(body) {
  return async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function storageDouble() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}
