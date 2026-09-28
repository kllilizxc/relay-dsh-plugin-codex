import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CODEX_SYNC_PATH,
  createCodexSyncHandler,
  registerCodexSyncRoute,
} from "../codex-sync-route.js";

test("Codex sync registers one exact DSH Web route", () => {
  let registration;
  const dispose = () => {};
  assert.equal(registerCodexSyncRoute({
    webServer: { register(value) { registration = value; return dispose; } },
  }, { synchronizer: synchronizer() }), dispose);
  assert.equal(registration.kind, "exact");
  assert.equal(registration.path, CODEX_SYNC_PATH);
});

test("sync route returns sanitized reconciliation counts", async () => {
  const service = synchronizer();
  const response = recorder();
  await createCodexSyncHandler({ synchronizer: service })(request({ sessionId: "session-1" }), response);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    status: "synced",
    projectedMessages: 2,
    projectedTurns: 1,
    skippedItems: 3,
  });
  assert.deepEqual(service.calls, ["session-1"]);
});

test("sync route rejects unsafe requests and malformed Session IDs", async () => {
  const handler = createCodexSyncHandler({ synchronizer: synchronizer(), token: "secret", maxBodyBytes: 64 });
  const wrongMethod = recorder();
  await handler(request({}, { method: "GET" }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const remote = recorder();
  await handler(request({ sessionId: "session-1" }, { remoteAddress: "10.0.0.8" }), remote);
  assert.equal(remote.status, 403);

  const missing = recorder();
  await handler(request({}), missing);
  assert.equal(missing.status, 400);

  const oversized = recorder();
  await handler(request({ sessionId: "x".repeat(100) }), oversized);
  assert.equal(oversized.status, 413);
});

function synchronizer() {
  return {
    calls: [],
    async syncSession(sessionId) {
      this.calls.push(sessionId);
      return { status: "synced", projectedMessages: 2, projectedTurns: 1, skippedItems: 3 };
    },
  };
}

function request(body, { method = "POST", remoteAddress = "127.0.0.1" } = {}) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.headers = { "content-type": "application/json" };
  stream.socket = { remoteAddress };
  return stream;
}

function recorder() {
  return {
    status: null,
    headers: null,
    body: "",
    json: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(body = "") { this.body += body; },
    end(body = "") {
      this.body += body;
      this.json = this.body ? JSON.parse(this.body) : null;
    },
  };
}
