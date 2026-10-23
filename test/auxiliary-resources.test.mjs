import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexSessionRuntime } from "../session-runtime.mjs";

class Client extends EventEmitter {
  requests = [];
  config = {};
  configError = null;
  async request(method, params) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "config/read") {
      if (this.configError) throw this.configError;
      return { config: structuredClone(this.config) };
    }
    if (method === "thread/start") return { thread: { id: "auxiliary", cwd: params.cwd, turns: [], ephemeral: params.ephemeral } };
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    throw new Error(`Unexpected ${method}`);
  }
}

const auxiliary = { ephemeral: true, toolFree: true, dynamicTools: [], sandbox: "read-only", approvalPolicy: "never" };

test("tool-free auxiliary calls cannot start inherited MCP or plugin processes", async () => {
  const client = new Client();
  client.config = {
    mcp_servers: { "project.tools": { command: "private-command", env: { SECRET: "private-value" } }, disabled: { enabled: false } },
    plugins: { "tools@example": { enabled: true }, "disabled@example": { enabled: false } },
  };
  const before = structuredClone(client.config);
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace/project" });
  await runtime.createSession(auxiliary);
  const start = client.requests.find(r => r.method === "thread/start");
  assert.equal(start.params.config.mcp_servers?.["project.tools"]?.enabled, false);
  assert.equal(start.params.config.mcp_servers?.disabled?.enabled, false);
  assert.equal(start.params.config.plugins?.["tools@example"]?.enabled, false);
  assert.equal(start.params.config["features.code_mode_host"], false);
  assert.doesNotMatch(JSON.stringify(start.params.config), /private-command|private-value/);
  assert.deepEqual(client.config, before);
  assert.deepEqual(client.requests[0], { method: "config/read", params: { cwd: "/workspace/project", includeLayers: false } });
});

test("ordinary tasks retain their inherited tools and do not read auxiliary config", async () => {
  const client = new Client();
  client.configError = Error("must not read auxiliary config");
  const runtime = new CodexSessionRuntime({ client });
  const dynamicTools = [{ name: "host_tool", description: "task tool", inputSchema: {} }];
  await runtime.createSession({ dynamicTools });
  assert.deepEqual(client.requests.map(r => r.method), ["thread/start"]);
  assert.deepEqual(client.requests[0].params.config, { "features.realtime_conversation": false });
  assert.deepEqual(client.requests[0].params.dynamicTools, dynamicTools);
});

test("auxiliary isolation uses current project config rather than a cached global server list", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  client.config = { mcp_servers: { first: { command: "first" } } };
  await runtime.createSession({ ...auxiliary, cwd: "/workspace/first" });
  client.config = { mcp_servers: { second: { command: "second" } } };
  await runtime.createSession({ ...auxiliary, cwd: "/workspace/second" });
  const starts = client.requests.filter(r => r.method === "thread/start");
  assert.deepEqual(Object.keys(starts[1].params.config.mcp_servers ?? {}), ["second"]);
  assert.equal(starts[1].params.config.mcp_servers.second.enabled, false);
  assert.equal(client.requests.filter(r => r.method === "config/read")[1].params.cwd, "/workspace/second");
});

test("unreadable config does not fall back to spawning tools for an auxiliary call", async () => {
  const client = new Client();
  const error = Error("config unavailable");
  client.configError = error;
  const runtime = new CodexSessionRuntime({ client });
  await assert.rejects(runtime.createSession(auxiliary), error);
  assert.equal(client.requests.some(r => r.method === "thread/start"), false);
});

test("completed auxiliary calls unsubscribe without archiving a user task", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  const session = await runtime.createSession(auxiliary);
  await runtime.releaseSession(session.id);
  assert.equal(runtime.getSession(session.id), null);
  assert.equal(client.requests.at(-1).method, "thread/unsubscribe");
  assert.equal(client.requests.some(r => r.method === "thread/archive"), false);
});


test("runtime invalidation does not clone unrelated thread histories", () => {
  const runtime = new CodexSessionRuntime({ client: new Client() });
  runtime.snapshot = () => { throw Error("Unrelated histories were cloned for a change signal"); };
  let changed = 0;
  runtime.on("change", () => { changed += 1; });
  runtime.emitChange();
  assert.equal(changed, 1);
});
