import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { READ_ONLY_NATIVE_TOOL_INSTRUCTIONS, NATIVE_TOOL_RESTRICTION_INSTRUCTIONS } from "../native-tool-policy.mjs";
import { CodexSessionRuntime } from "../session-runtime.mjs";

class Client extends EventEmitter {
  requests = [];
  errors = [];
  config = {
    features: { shell_tool: false, view_image: false },
    mcp_servers: { inherited: { command: "private-command" } },
    plugins: { inherited: { enabled: true } },
  };
  async request(method, params = {}) {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "config/read") return { config: structuredClone(this.config) };
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      return { thread: { id: method === "thread/fork" ? "fork" : "thread", cwd: params.cwd, turns: [] } };
    }
    if (method === "thread/unsubscribe") return { status: "unsubscribed" };
    if (method === "thread/settings/update") return {};
    if (method === "thread/backgroundTerminals/list") return { data: [], nextCursor: null };
    if (method === "turn/start") return { turn: { id: "turn", status: "inProgress", items: [] } };
    throw Error(`Unexpected ${method}`);
  }
  respondError(id, code, message) { this.errors.push({ id, code, message }); }
}

function assertRestricted(params) {
  assert.equal(params.permissions, ":read-only");
  assert.deepEqual(params.runtimeWorkspaceRoots, []);
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.config["features.shell_tool"], false);
  assert.equal(params.config["features.code_mode_host"], false);
  assert.equal(params.config["features.multi_agent"], false);
  assert.equal(params.config["features.apps"], false);
  assert.equal(params.config["features.browser_use"], false);
  assert.equal(params.config["features.view_image"], false);
  assert.equal(params.config["features.hooks"], true);
  assert.equal(params.config["hooks.PreToolUse"][0].matcher, ".*");
  assert.equal(params.config.web_search, "disabled");
  assert.deepEqual(params.config.mcp_servers, { inherited: { enabled: false } });
  assert.deepEqual(params.config.plugins, { inherited: { enabled: false } });
  assert.doesNotMatch(JSON.stringify(params.config), /private-command/);
}

test("empty native grant restricts fresh and forked threads and every turn despite permission settings", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace" });
  const tools = [{ name: "workbench", inputSchema: {} }];
  const session = await runtime.createSession({ nativeToolAllowlist: [], sandbox: "danger-full-access", dynamicTools: tools });
  assertRestricted(client.requests.find(r => r.method === "thread/start").params);
  assert.deepEqual(client.requests.find(r => r.method === "thread/start").params.dynamicTools, tools);
  assert.equal(session.nativeToolsRestricted, true);
  await runtime.sendMessage(session.id, { text: "work", sandbox: "danger-full-access", approvalPolicy: "on-request" });
  const turn = client.requests.find(r => r.method === "turn/start").params;
  assert.equal(turn.permissions, ":read-only");
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(turn.runtimeWorkspaceRoots, []);
  assert.equal(typeof turn.collaborationMode.settings.developer_instructions, "string");
  assert.ok(turn.collaborationMode.settings.developer_instructions.length > 0);
  await runtime.forkSession(session.id, { lastTurnId: "turn", nativeToolAllowlist: [] });
  assertRestricted(client.requests.find(r => r.method === "thread/fork").params);
});

test("native grant transitions unload existing threads before applying or removing overrides", async () => {
  const client = new Client();
  const before = structuredClone(client.config);
  const runtime = new CodexSessionRuntime({ client, cwd: "/workspace" });
  const session = await runtime.createSession();
  client.requests.length = 0;
  await runtime.resumeSession(session.id, { nativeToolAllowlist: [] });
  assert.deepEqual(client.requests.map(r => r.method), ["thread/unsubscribe", "config/read", "thread/resume"]);
  assertRestricted(client.requests.at(-1).params);
  client.requests.length = 0;
  await runtime.resumeSession(session.id, { sandbox: "workspace-write", approvalPolicy: "on-request" });
  assert.deepEqual(client.requests.map(r => r.method), ["thread/unsubscribe", "thread/resume"]);
  const restored = client.requests.at(-1).params;
  assert.equal(restored.config, undefined, "resume must inherit current config, never force-enable features");
  assert.equal(restored.permissions, ":workspace");
  assert.equal(runtime.getSession(session.id).nativeToolsRestricted, false);
  assert.deepEqual(client.config, before);
});

test("native policy changes never unload or interrupt a running turn", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  const session = await runtime.createSession();
  await runtime.sendMessage(session.id, { text: "working" });
  client.requests.length = 0;
  await assert.rejects(runtime.resumeSession(session.id, { nativeToolAllowlist: [] }), /during a running Codex turn/);
  await assert.rejects(runtime.resumeSession(session.id, { developerInstructions: "updated host policy" }), /during a running Codex turn/);
  assert.deepEqual(client.requests, []);
});

test("trusted system instructions reach each turn alongside native restrictions without persistence", async () => {
  for (const nativeToolAllowlist of [undefined, []]) {
    const client = new Client();
    const runtime = new CodexSessionRuntime({ client });
    const session = await runtime.createSession({ nativeToolAllowlist, developerInstructions: "first host policy" });
    await runtime.resumeSession(session.id, { nativeToolAllowlist, developerInstructions: "next host policy" });
    await runtime.sendMessage(session.id, { text: "next", nativeToolAllowlist });
    const turns = client.requests.filter(r => r.method === "turn/start");
    const first = client.requests.find(r => r.method === "thread/start").params.developerInstructions;
    const next = client.requests.find(r => r.method === "thread/resume").params.developerInstructions;
    assert.ok(first.startsWith("first host policy"));
    assert.ok(next.startsWith("next host policy"));
    assert.equal(next.includes("first host policy"), false);
    if (nativeToolAllowlist) {
      assert.equal(turns[0].params.permissions, ":read-only");
      assert.ok(next.length > "next host policy".length, "the native boundary remains alongside the host policy");
    } else assert.equal(next, "next host policy");
    assert.equal(runtime.getSession(session.id).developerInstructions, undefined);
    const methods = client.requests.map(r => r.method);
    assert.ok(methods.indexOf("thread/unsubscribe") < methods.indexOf("thread/resume"));
  }
});

test("selecting an existing restricted thread preserves its native policy", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  const session = await runtime.createSession({ nativeToolAllowlist: [], developerInstructions: "current host policy" });
  client.requests.length = 0;
  await runtime.selectSession(session.id);
  assertRestricted(client.requests.at(-1).params);
  assert.ok(client.requests.at(-1).params.developerInstructions.startsWith("current host policy"));
  assert.equal(runtime.getSession(session.id).nativeToolsRestricted, true);
});

test("idle runtime replacement preserves the trusted prompt when selecting a restricted thread", async () => {
  const previous = new CodexSessionRuntime({ client: new Client() });
  const session = await previous.createSession({ nativeToolAllowlist: [], developerInstructions: "retained host policy" });
  const client = new Client();
  const replacement = new CodexSessionRuntime({ client });
  replacement.adoptStateFrom(previous);
  await replacement.selectSession(session.id);
  const resumed = client.requests.find(request => request.method === "thread/resume").params;
  assert.ok(resumed.developerInstructions.startsWith("retained host policy"));
  assertRestricted(resumed);
  assert.equal(replacement.getSession(session.id).id, session.id);
});

test("failed restricted setup retires the unloaded cache so ordinary retry resumes the same thread", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  const session = await runtime.createSession();
  const original = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "config/read") throw Error("config unavailable");
    return original(method, params);
  };
  await assert.rejects(runtime.resumeSession(session.id, { nativeToolAllowlist: [] }), /config unavailable/);
  assert.equal(runtime.getSession(session.id), null);
  const resumed = await runtime.resumeSession(session.id);
  assert.equal(resumed.id, session.id);
  assert.equal(client.requests.filter(r => r.method === "thread/start").length, 1);
  assert.equal(client.requests.at(-1).method, "thread/resume");
});

test("an unsubscribe that cannot establish unloading fails closed", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  const session = await runtime.createSession();
  const original = client.request.bind(client);
  client.request = async (method, params) => method === "thread/unsubscribe"
    ? { status: "notSubscribed" } : original(method, params);
  await assert.rejects(runtime.resumeSession(session.id, { nativeToolAllowlist: [] }), /returned notSubscribed/);
  assert.equal(client.requests.some(r => r.method === "thread/resume"), false);
});

test("restricted threads reject stale native interactions but keep DSH dynamic tool requests", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  await runtime.createSession({ nativeToolAllowlist: [] });
  const requests = [];
  runtime.on("request", request => requests.push(request));
  runtime.handleServerRequest({ id: "approval", method: "item/fileChange/requestApproval", params: { threadId: "thread" } });
  runtime.handleServerRequest({ id: "builtin", method: "item/tool/call", params: { threadId: "thread", namespace: "codex_app", tool: "load_workspace_dependencies" } });
  runtime.handleServerRequest({ id: "host", method: "item/tool/call", params: { threadId: "thread", namespace: "dsh", tool: "workbench" } });
  assert.deepEqual(client.errors.map(error => error.id), ["approval", "builtin"]);
  assert.deepEqual(requests.map(request => request.id), ["host"]);
});


test("partial and writable host grants keep native execution disabled", async () => {
  for (const allowlist of [["read"], ["read_image"], ["glob", "grep"], ["read", "write", "edit"], ["shell"]]) {
    const client = new Client();
    const runtime = new CodexSessionRuntime({ client, cwd: "/workspace" });
    const session = await runtime.createSession({ nativeToolAllowlist: allowlist, dynamicTools: [{name:"dsh",tools:[]}] });
    assertRestricted(client.requests.at(-1).params);
    assert.deepEqual(runtime.getSession(session.id).nativeToolAllowlist, allowlist);
    await runtime.sendMessage(session.id, {text:"inspect",nativeToolAllowlist:allowlist});
    assert.equal(client.requests.find(r=>r.method==="turn/start").params.permissions, ":read-only");
  }
});

test("turn cannot narrow or change the thread grant without reloading its config", async () => {
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  const fullRead = ["read", "read_image", "glob", "grep"];
  const session = await runtime.createSession({ nativeToolAllowlist: fullRead });
  client.requests.length = 0;
  await assert.rejects(runtime.sendMessage(session.id, { text: "work", nativeToolAllowlist: [] }), /resume the thread/);
  assert.deepEqual(client.requests, []);
  await runtime.resumeSession(session.id, { nativeToolAllowlist: [] });
  client.requests.length = 0;
  await assert.rejects(runtime.sendMessage(session.id, { text: "work", nativeToolAllowlist: fullRead }), /resume the thread/);
  assert.deepEqual(client.requests, []);
});

test("best-effort hook permits host tools and denies native patch", async () => {
  const { spawnSync } = await import("node:child_process");
  const client = new Client();
  const runtime = new CodexSessionRuntime({ client });
  await runtime.createSession({ nativeToolAllowlist: [] });
  const command = client.requests.find(r => r.method === "thread/start").params.config["hooks.PreToolUse"][0].hooks[0].command;
  const run = tool_name => {
    const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify({tool_name}), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(run("dshworkbench"), {});
  assert.equal(run("apply_patch").hookSpecificOutput.permissionDecision, "deny");
});
