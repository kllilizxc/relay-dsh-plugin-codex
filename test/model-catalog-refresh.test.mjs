import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexRuntimeController } from "../plugin.mjs";
import { CodexDshAdapter } from "../codex-adapter.js";

const model = (id) => ({
  id, displayName: id, isDefault: true, defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
});

class CatalogClient extends EventEmitter {
  constructor(id = "old-model") { super(); this.models = [model(id)]; this.calls = []; }
  async start() {}
  async close() { this.closed = true; }
  async request(method) {
    this.calls.push(method);
    if (method === "model/list") return this.read ? this.read() : { data: this.models };
    if (method === "account/read") return null;
    if (method === "thread/list") return { data: [] };
    throw new Error(`Unexpected method: ${method}`);
  }
}

test("catalog refresh merges concurrent reads and synchronizes models and reasoning without session changes", async (t) => {
  const client = new CatalogClient();
  const controller = new CodexRuntimeController({ client, cwd: "/workspace" });
  t.after(() => controller.close());
  await controller.start();
  const adapter = new CodexDshAdapter({ runtime: controller, ready: controller.whenReady() });
  adapter.configure("session-1", { model: "old-model", effort: "ultra" });
  adapter.links.set("session-1", "thread-1");
  const session = { id: "thread-1", model: "old-model", effort: "ultra", turns: [] };
  controller.current.runtime.sessions.set(session.id, session);
  const settings = structuredClone(adapter.settings.get("session-1"));
  const entry = controller.current;
  const pending = Promise.withResolvers();
  client.read = () => pending.promise;

  const first = adapter.listModels();
  const second = adapter.listModels();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.calls.filter(method => method === "model/list").length, 2);
  pending.resolve({ data: [model("old-model"), model("gpt-6.1-terra")] });
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.some(value => value.id === "gpt-6.1-terra"), true);
  }
  const resolved = await adapter.resolveModel("relay-codex", "gpt-6.1-terra");
  assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ["low", "ultra"]);
  assert.equal(resolved.reasoning.defaultEffort, "low");
  assert.equal(controller.current, entry);
  assert.equal(controller.current.runtime.sessions.get(session.id), session);
  assert.equal(adapter.links.get("session-1"), "thread-1");
  assert.deepEqual(adapter.settings.get("session-1"), settings);
});

test("failed, malformed and empty refreshes retain the last usable catalog and permit recovery", async (t) => {
  const client = new CatalogClient();
  const controller = new CodexRuntimeController({ client, cwd: "/workspace" });
  controller.logger = { warn() {} };
  t.after(() => controller.close());
  await controller.start();
  for (const read of [() => { throw new Error("offline"); }, () => ({}), () => ({ data: [] })]) {
    client.read = read;
    assert.deepEqual((await controller.refreshModels()).map(value => value.id), ["old-model"]);
  }
  client.read = () => ({ data: [model("gpt-6.1-terra")] });
  assert.deepEqual((await controller.refreshModels()).map(value => value.id), ["gpt-6.1-terra"]);
});

test("a late catalog from the previous runtime cannot overwrite the replacement runtime", async (t) => {
  const clients = [];
  const controller = new CodexRuntimeController({
    cwd: "/workspace", clientFactory(id) { const client = new CatalogClient(id); clients.push(client); return client; },
  });
  t.after(() => controller.close());
  await controller.start("runtime-one");
  const pending = Promise.withResolvers();
  clients[0].read = () => pending.promise;
  const stale = controller.refreshModels();
  await new Promise(resolve => setImmediate(resolve));
  await controller.reload("runtime-two");
  pending.resolve({ data: [model("obsolete")] });
  assert.deepEqual((await stale).map(value => value.id), ["runtime-two"]);
  assert.deepEqual(controller.listModels().map(value => value.id), ["runtime-two"]);
});

test("refresh after standby wakes one child and discovers new models without creating a thread", async (t) => {
  const clients = [];
  const controller = new CodexRuntimeController({
    cwd: "/workspace", idleTimeoutMs: 5,
    clientFactory() {
      const client = new CatalogClient(clients.length ? "gpt-6.1-terra" : "old-model");
      clients.push(client);
      return client;
    },
  });
  t.after(() => controller.close());
  await controller.start("runtime-one");
  for (let count = 0; controller.current && count < 50; count++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(controller.status().state, "standby");
  const first = controller.refreshModels();
  assert.equal(controller.refreshModels(), first);
  assert.deepEqual((await first).map(value => value.id), ["gpt-6.1-terra"]);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].closed, true);
  assert.equal(clients.flatMap(client => client.calls).some(method => method === "thread/start"), false);
});
