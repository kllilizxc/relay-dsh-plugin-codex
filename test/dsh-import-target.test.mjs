import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { freezeMessage, MessageId } from "@deepseek-ai/dsh-llm";
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId } from "@deepseek-ai/dsh-session";
import { sessionEvents } from "../dsh-compat.mjs";

import {
  buildCodexHistorySeed,
  codexHistoryRebuildReason,
  DshCodexImportTarget,
  projectCodexHistory,
  rebuiltSessionId,
} from "../dsh-import-target.js";

const SOURCE_UPDATED_AT = 1_700_000_123;

test("Codex history projects native user and assistant messages in order and is idempotent", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-history-projection"), {
    meta: { cwd: "/workspace/relay" },
  });
  const turns = [
    {
      id: "turn-1",
      status: "completed",
      items: [
        { type: "userMessage", id: "u1", content: [{ type: "text", text: "question one" }] },
        { type: "reasoning", id: "r1", summary: ["private summary"] },
        { type: "commandExecution", id: "c1", command: "pwd", aggregatedOutput: "/workspace/relay" },
        { type: "agentMessage", id: "a1", text: "progress one", phase: "commentary" },
        { type: "agentMessage", id: "a2", text: "answer one", phase: "final_answer" },
        { type: "contextCompaction", id: "compact-1" },
      ],
    },
    {
      id: "turn-2",
      status: "completed",
      items: [
        { type: "userMessage", id: "u2", content: [{ type: "inputText", text: "question two" }] },
        { type: "unknownFutureItem", id: "future-1", payload: "opaque" },
        { type: "agentMessage", id: "a3", text: "answer two", phase: "final_answer" },
      ],
    },
  ];

  const first = projectCodexHistory(session, turns);
  const second = projectCodexHistory(session, turns);
  const messages = session.deriveMessages();

  assert.deepEqual(first, { projectedMessages: 5, projectedActivities: 1, projectedTurns: 2, skippedItems: 3 });
  assert.deepEqual(second, { projectedMessages: 0, projectedActivities: 0, projectedTurns: 0, skippedItems: 3 });
  assert.deepEqual(messages.map(message => ({
    id: String(message.id),
    role: message.role,
    text: message.content.flatMap(block => block.type === "text"
      ? [block.text]
      : block.type === "tool-result"
        ? block.content.filter(content => content.type === "text").map(content => content.text)
        : []).join("\n"),
  })), [
    { id: "codex:turn-1:user:u1", role: "user", text: "question one" },
    { id: "codex:turn-1:activity:c1:request", role: "assistant", text: "" },
    { id: "codex:turn-1:activity:c1:result", role: "user", text: "/workspace/relay" },
    { id: "codex:turn-1:assistant:a1", role: "assistant", text: "progress one" },
    { id: "codex:turn-1:assistant:a2", role: "assistant", text: "answer one" },
    { id: "codex:turn-2:user:u2", role: "user", text: "question two" },
    { id: "codex:turn-2:assistant:a3", role: "assistant", text: "answer two" },
  ]);
  assert.deepEqual(sessionEvents(session).filter(event => event.type === "tool/call").map(event => ({
    name: event.data.name,
    arguments: JSON.parse(event.data.arguments),
  })), [{
    name: "bash",
    arguments: { command: "pwd", description: "pwd" },
  }]);
  assert.equal(messages.some(message => message.content.some(
    block => block.type === "text" && block.text.includes("imported from"),
  )), false);
  assert.equal(sessionEvents(session).every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), true);
  await ctx.fiber.dispose();
});

test("Codex history preserves public activity types without exposing private reasoning", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-activity-projection"));
  const turns = [{
    id: "activity-turn",
    status: "completed",
    items: [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "fix it" }] },
      { type: "reasoning", id: "reasoning", summary: ["visible summary"], content: ["private chain"] },
      { type: "agentMessage", id: "commentary", text: "I will inspect it.", phase: "commentary" },
      {
        type: "commandExecution",
        id: "command",
        command: "npm test",
        cwd: "/workspace/relay",
        status: "completed",
        exitCode: 1,
        aggregatedOutput: "one test failed\n",
      },
      {
        type: "fileChange",
        id: "file",
        status: "completed",
        changes: [{
          path: "/workspace/relay/src/a.js",
          kind: { type: "update" },
          diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
        }],
      },
      { type: "webSearch", id: "web", query: "DSH events", action: { queries: ["DSH events"] }, results: null },
      {
        type: "mcpToolCall",
        id: "mcp",
        server: "chrome",
        tool: "inspect",
        status: "failed",
        arguments: { tab: 1 },
        result: null,
        error: { message: "tab closed", code: "TAB_CLOSED" },
      },
      { type: "agentMessage", id: "final", text: "Fixed.", phase: "final_answer" },
    ],
  }];

  const result = projectCodexHistory(session, turns);
  const calls = sessionEvents(session).filter(event => event.type === "tool/call");
  const results = sessionEvents(session).filter(event => event.type === "tool/result");
  const serialized = JSON.stringify(sessionEvents(session));

  assert.deepEqual(result, { projectedMessages: 3, projectedActivities: 4, projectedTurns: 1, skippedItems: 1 });
  assert.deepEqual(calls.map(event => event.data.name), ["bash", "edit", "web_search", "run_code"]);
  assert.deepEqual(results.map(event => event.data.message.content[0].isError), [false, false, false, true]);
  assert.deepEqual(results[1].data.meta, {
    diffs: [{ path: "/workspace/relay/src/a.js", oldText: "old", newText: "new" }],
  });
  assert.equal(serialized.includes("one test failed"), true);
  assert.equal(serialized.includes("tab closed"), true);
  assert.equal(serialized.includes("private chain"), false);
  assert.equal(serialized.includes("visible summary"), false);
  assert.equal(sessionEvents(session).every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), true);
  await ctx.fiber.dispose();
});

test("history consistency detects changed Codex activity output", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-activity-drift"));
  appendCodexRequestHeader(session);
  const original = {
    id: "activity-drift-turn",
    status: "completed",
    items: [
      { type: "userMessage", id: "user", content: [{ type: "text", text: "run" }] },
      { type: "commandExecution", id: "command", command: "pwd", status: "completed", exitCode: 0, aggregatedOutput: "/old" },
      { type: "agentMessage", id: "answer", text: "done" },
    ],
  };
  projectCodexHistory(session, [original]);
  const changed = structuredClone(original);
  changed.items[1].aggregatedOutput = "/new";

  assert.equal(codexHistoryRebuildReason(session, [changed], {
    requestConfig: { provider: "relay-codex", model: "codex-test" },
  }), "codex-activity-result-drift");
  await ctx.fiber.dispose();
});

test("an empty Codex history does not add a private persistence event", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-empty-history"), {
    meta: { cwd: "/workspace/relay" },
  });

  const projected = projectCodexHistory(session, []);

  assert.deepEqual(projected, { projectedMessages: 0, projectedActivities: 0, projectedTurns: 0, skippedItems: 0 });
  assert.equal(session.deriveMessages().length, 0);
  assert.deepEqual(sessionEvents(session), []);
  await ctx.fiber.dispose();
});

test("Codex history seed stamps native events with exact source recency", () => {
  const seed = buildCodexHistorySeed([{
    id: "source-turn",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "source question" }] },
      { type: "reasoning", summary: ["private"] },
      { type: "agentMessage", text: "source answer" },
    ],
  }], SOURCE_UPDATED_AT);

  assert.equal(seed.length, 6);
  assert.equal(seed.every((event, index) => event.seq === index), true);
  assert.equal(seed.every(event => event.time === SOURCE_UPDATED_AT * 1000), true);
  assert.equal(seed.every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), true);
  assert.deepEqual(seed.filter(event => event.type === "user/message").map(event => event.data.id), [
    "codex:source-turn:user:userMessage-0-0",
  ]);
});

test("history consistency detects assistant text appended to an existing Codex Turn", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-growing-turn"));
  appendCodexRequestHeader(session);
  const partial = sourceTurn("growing-turn", "question", "progress", "interrupted");
  projectCodexHistory(session, [partial]);
  const completed = sourceTurn("growing-turn", "question", "progress", "completed");
  completed.items.push({ type: "agentMessage", text: "final conclusion", phase: "final_answer" });

  assert.equal(codexHistoryRebuildReason(session, [completed], {
    requestConfig: { provider: "relay-codex", model: "codex-test" },
  }), "codex-turn-partially-projected");
  await ctx.fiber.dispose();
});

test("history consistency detects a Codex Turn changing from interrupted to completed", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-status-change"));
  appendCodexRequestHeader(session);
  const interrupted = sourceTurn("status-turn", "question", "same answer", "interrupted");
  projectCodexHistory(session, [interrupted]);
  const completed = sourceTurn("status-turn", "question", "same answer", "completed");

  assert.equal(codexHistoryRebuildReason(session, [completed], {
    requestConfig: { provider: "relay-codex", model: "codex-test" },
  }), "codex-turn-end-reason-drift");
  await ctx.fiber.dispose();
});

test("history consistency rejects splitting one Codex Turn across DSH Turns", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-partial-turn"));
  appendCodexRequestHeader(session);
  projectCodexHistory(session, [{
    id: "partial-turn",
    status: "interrupted",
    items: [{ type: "userMessage", content: [{ type: "text", text: "question" }] }],
  }]);
  const completed = sourceTurn("partial-turn", "question", "final conclusion", "completed");

  assert.equal(codexHistoryRebuildReason(session, [completed], {
    requestConfig: { provider: "relay-codex", model: "codex-test" },
  }), "codex-turn-partially-projected");
  await ctx.fiber.dispose();
});

test("new imported Sessions use inventory recency even when thread/read differs", async () => {
  const source = thread({
    model: "codex-source",
    effort: "low",
    createdAt: 1_600_000_000,
    updatedAt: SOURCE_UPDATED_AT - 100,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [{ type: "userMessage", content: [{ type: "text", text: "question" }] }],
      },
      {
        id: "turn-running",
        status: "inProgress",
        items: [{ type: "userMessage", content: [{ type: "text", text: "unfinished" }] }],
      },
    ],
  });
  let createOptions;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    ctx: {
      agents: {
        get: () => undefined,
        create: async (options) => {
          createOptions = options;
          return { agent: { session: {} }, dispose: async () => {} };
        },
      },
      sessionPersistence: { list: async () => [] },
    },
  });

  await target.prepare({
    thread: { ...source, updatedAt: SOURCE_UPDATED_AT },
    binding: binding("import-with-history"),
    workspaceCwd: source.cwd,
  });

  assert.equal(createOptions.meta.createdAt, source.createdAt * 1000);
  assert.deepEqual(createOptions.seed.find(event => event.type === "request/header")?.data, {
    header: {
      config: {
        provider: "relay-codex",
        model: "codex-source",
        reasoningEffort: "low",
      },
    },
    reason: "initial",
  });
  assert.equal(createOptions.seed.find(event => event.type === "user/message").time, SOURCE_UPDATED_AT * 1000);
  assert.equal(createOptions.seed.some(event => event.data?.id === "codex:turn-running:user"), false);
});

test("zero-turn imported Sessions use source updatedAt as list recency", async () => {
  const source = thread({ createdAt: 1_600_000_000, updatedAt: SOURCE_UPDATED_AT, turns: [] });
  let createOptions;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    ctx: {
      agents: {
        get: () => undefined,
        create: async (options) => {
          createOptions = options;
          return { agent: { session: {} }, dispose: async () => {} };
        },
      },
      sessionPersistence: { list: async () => [] },
    },
  });

  await target.prepare({
    thread: source,
    binding: binding("import-empty"),
    workspaceCwd: source.cwd,
  });

  assert.deepEqual(createOptions.seed, [{
    type: "request/header",
    seq: 0,
    time: source.updatedAt * 1000,
    data: {
      header: { config: { provider: "relay-codex", model: "codex-test" } },
      reason: "initial",
    },
  }]);
  assert.equal(createOptions.meta.createdAt, source.updatedAt * 1000);
});

test("hydrate waits for the title projection durability barrier", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-title-barrier"), {
    meta: { cwd: "/workspace/relay" },
  });
  ctx.provide("sessionTitle", {
    get(candidate) {
      const event = sessionEvents(candidate).findLast(item => item.type === "session/title");
      return event ? { title: event.data.title } : undefined;
    },
    rename(candidate, title) {
      candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
    },
  });
  let releaseWrite;
  let durable = false;
  ctx.provide("sessionProjectionCache", {
    write: async (candidate) => {
      assert.equal(sessionEvents(candidate).at(-1)?.type, "session/title");
      await new Promise(resolve => { releaseWrite = resolve; });
      durable = true;
    },
  });
  const target = new DshCodexImportTarget({ ctx, runtime: {} });
  const pending = target.hydrate({
    source: thread({ name: "Imported title", turns: [] }),
    agent: { session },
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(durable, false);
  releaseWrite();
  assert.deepEqual(await pending, { projectedMessages: 0, projectedActivities: 0, projectedTurns: 0, skippedItems: 0 });
  assert.equal(durable, true);
  await ctx.fiber.dispose();
});

test("hydrate rejects a DSH composition without projection durability", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId("codex-title-no-cache"), {
    meta: { cwd: "/workspace/relay" },
  });
  ctx.provide("sessionTitle", {
    get: () => undefined,
    rename(candidate, title) {
      candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
    },
  });
  const target = new DshCodexImportTarget({ ctx, runtime: {} });

  await assert.rejects(target.hydrate({
    source: thread({ name: "Imported title", turns: [] }),
    agent: { session },
  }), /sessionProjectionCache/);
  await ctx.fiber.dispose();
});

test("open-time sync appends missing terminal external Turns and defers in-progress work", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const session = context.sessions.create(SessionId("codex-open-sync"), {
    meta: { cwd: "/workspace/relay" },
  });
  appendCodexRequestHeader(session);
  projectCodexHistory(session, [sourceTurn("initial-turn", "initial question", "initial answer")]);
  appendDshOwnedTurn(session, 2, "owned-turn");

  const source = thread({
    turns: [
      sourceTurn("initial-turn", "initial question", "initial answer"),
      sourceTurn("owned-turn", "owned question", "owned answer"),
      sourceTurn("ledger-turn", "ledger question", "ledger answer"),
      sourceTurn("external-turn", "external question", "external answer"),
      sourceTurn("interrupted-turn", "interrupted question", "interrupted answer", "interrupted"),
      sourceTurn("failed-turn", "failed question", "failed answer", "failed"),
      sourceTurn("running-turn", "running question", "partial answer", "inProgress"),
    ],
  });
  let reads = 0;
  let flushes = 0;
  let cacheWrites = 0;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => { reads += 1; return structuredClone(source); } },
    ctx: {
      agents: { get: id => String(id) === "codex-open-sync" ? { session } : undefined },
      sessions: { flush: async candidate => { assert.equal(candidate, session); flushes += 1; } },
      get: key => key === "sessionProjectionCache"
        ? { write: async candidate => { assert.equal(candidate, session); cacheWrites += 1; } }
        : undefined,
    },
  });
  const importedBinding = {
    ...binding("codex-open-sync"),
    importState: "committed",
  };

  assert.deepEqual(await target.sync(importedBinding, new Set(["ledger-turn"])), {
    projectedMessages: 6,
    projectedActivities: 0,
    projectedTurns: 3,
    skippedItems: 0,
    modelSelectionChanged: false,
  });
  assert.deepEqual(await target.sync(importedBinding, new Set(["ledger-turn"])), {
    projectedMessages: 0,
    projectedActivities: 0,
    projectedTurns: 0,
    skippedItems: 0,
    modelSelectionChanged: false,
  });
  const texts = session.deriveMessages().flatMap(message => message.content
    .filter(block => block.type === "text").map(block => block.text));
  assert.equal(texts.includes("external question"), true);
  assert.equal(texts.includes("external answer"), true);
  assert.equal(texts.includes("interrupted question"), true);
  assert.equal(texts.includes("interrupted answer"), true);
  assert.equal(texts.includes("failed question"), true);
  assert.equal(texts.includes("failed answer"), true);
  assert.equal(texts.includes("ledger question"), false);
  assert.equal(texts.includes("running question"), false);
  assert.deepEqual(sessionEvents(session).filter(event => event.type === "turn/end").slice(-3).map(event => (
    event.data.reason.kind
  )), ["completed", "interrupted", "error"]);
  assert.equal(reads, 2);
  assert.equal(flushes, 1);
  assert.equal(cacheWrites, 1);
  assert.deepEqual(session.requestHeader()?.config, {
    provider: "relay-codex",
    model: "codex-test",
  });
  assert.equal(sessionEvents(session).every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), true);
  await context.fiber.dispose();
});

test("cold open-time sync loads persistence without publishing an Agent lifecycle", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const sessionId = SessionId("codex-open-sync-cold");
  const stored = context.sessions.prepare(sessionId, {
    seed: buildCodexHistorySeed([
      sourceTurn("initial-turn", "initial question", "initial answer"),
    ], SOURCE_UPDATED_AT, {
      terminalOnly: true,
      requestConfig: { provider: "relay-codex", model: "codex-test" },
    }),
    meta: { cwd: "/workspace/relay", agentPreset: "relay-codex" },
  });
  const durableEvents = structuredClone(sessionEvents(stored));
  const source = thread({
    updatedAt: SOURCE_UPDATED_AT + 1,
    turns: [
      sourceTurn("initial-turn", "initial question", "initial answer"),
      sourceTurn("external-turn", "external question", "external answer"),
    ],
  });
  let resumeCalls = 0;
  let appended = [];
  let cachedSession;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    ctx: {
      agents: {
        get: () => undefined,
        resume: async () => {
          resumeCalls += 1;
          throw new Error("open-time sync must not publish a resumed Agent");
        },
      },
      sessions: {
        get: () => undefined,
        prepare: (id, options) => context.sessions.prepare(id, options),
        flush: async () => { throw new Error("a cold detached Session must append directly"); },
      },
      sessionPersistence: {
        load: async id => {
          assert.equal(String(id), String(sessionId));
          return { meta: structuredClone(stored.header), events: structuredClone(durableEvents) };
        },
        append: async (id, events) => {
          assert.equal(String(id), String(sessionId));
          appended = structuredClone(events);
          durableEvents.push(...structuredClone(events));
        },
      },
      get: key => key === "sessionProjectionCache"
        ? { write: async candidate => { cachedSession = candidate; } }
        : undefined,
    },
  });

  const result = await target.sync({ ...binding(String(sessionId)), importState: "committed" });

  assert.equal(resumeCalls, 0);
  assert.equal(result.projectedMessages, 2);
  assert.equal(appended.length, 6);
  assert.equal(appended[0].seq, durableEvents.length - appended.length);
  assert.deepEqual(cachedSession.deriveMessages().map(message => String(message.id)), [
    "codex:initial-turn:user:userMessage-0-0",
    "codex:initial-turn:assistant:agentMessage-0-1",
    "codex:external-turn:user:userMessage-0-0",
    "codex:external-turn:assistant:agentMessage-0-1",
  ]);
  assert.equal(context.sessions.get(sessionId), undefined);
  await context.fiber.dispose();
});

test("cold sync forwards the rc.1 inherited event count when restoring persistence", async () => {
  const loaded = {
    meta: { id: "seeded", isSeeded: true },
    events: [{ type: "session/end-seed", seq: 0, time: 1, data: {} }],
    inheritedEventCount: 1,
  };
  let prepared;
  const target = new DshCodexImportTarget({
    runtime: {},
    ctx: {
      agents: { get: () => undefined },
      sessions: {
        get: () => undefined,
        prepare: (_id, options) => {
          prepared = options;
          return { id: "seeded", snapshotEvents: () => loaded.events };
        },
      },
      sessionPersistence: { load: async () => structuredClone(loaded) },
    },
  });

  const acquired = await target.acquireSessionForSync("seeded");

  assert.equal(prepared.inheritedEventCount, 1);
  assert.equal(prepared.seedSource, "persistence");
  assert.equal(acquired.persistedLength, 1);
});

test("cold open-time sync adopts a Session that becomes live during persistence load", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const sessionId = SessionId("codex-open-sync-became-live");
  const seed = buildCodexHistorySeed([
    sourceTurn("initial-turn", "initial question", "initial answer"),
  ], SOURCE_UPDATED_AT, {
    terminalOnly: true,
    requestConfig: { provider: "relay-codex", model: "codex-test" },
  });
  const live = context.sessions.create(sessionId, {
    seed,
    meta: { cwd: "/workspace/relay", agentPreset: "relay-codex" },
  });
  const source = thread({
    turns: [
      sourceTurn("initial-turn", "initial question", "initial answer"),
      sourceTurn("external-turn", "external question", "external answer"),
    ],
  });
  let lookups = 0;
  let flushes = 0;
  let directAppends = 0;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    ctx: {
      agents: {
        get: () => {
          lookups += 1;
          return lookups === 1 ? undefined : { session: live };
        },
      },
      sessions: {
        flush: async candidate => {
          assert.equal(candidate, live);
          flushes += 1;
        },
      },
      sessionPersistence: {
        load: async () => ({ meta: structuredClone(live.header), events: structuredClone(seed) }),
        append: async () => { directAppends += 1; },
      },
      get: key => key === "sessionProjectionCache" ? { write: async () => {} } : undefined,
    },
  });

  const result = await target.sync({ ...binding(String(sessionId)), importState: "committed" });

  assert.equal(result.projectedMessages, 2);
  assert.equal(flushes, 1);
  assert.equal(directAppends, 0);
  assert.equal(live.deriveMessages().some(message => String(message.id) === "codex:external-turn:user:userMessage-0-0"), true);
  await context.fiber.dispose();
});

test("open-time sync rebuilds when the imported DSH model header drifts", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const session = context.sessions.create(SessionId("codex-open-sync-model"), {
    meta: { cwd: "/workspace/relay" },
  });
  appendCodexRequestHeader(session, { model: "codex-fallback", reasoningEffort: "high" });
  projectCodexHistory(session, [sourceTurn("initial-turn", "initial question", "initial answer")]);

  const source = thread({
    model: "gpt-original",
    effort: "low",
    turns: [sourceTurn("initial-turn", "initial question", "initial answer")],
  });
  const importedBinding = {
    ...binding("codex-open-sync-model"),
    config: { model: "codex-fallback", effort: "high", cwd: "/workspace/relay" },
    importState: "committed",
  };
  const expectedSessionId = rebuiltSessionId(importedBinding.threadId, importedBinding.sessionId);
  let rebuiltSession;
  let replaced;
  let cacheWrites = 0;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    logger: { info() {} },
    adapter: {
      replaceImportedSession(oldSessionId, newSessionId) {
        replaced = { oldSessionId: String(oldSessionId), newSessionId: String(newSessionId) };
        return { ...importedBinding, sessionId: String(newSessionId) };
      },
    },
    ctx: {
      agents: {
        get: id => String(id) === "codex-open-sync-model" ? { session } : undefined,
        create: async (options) => {
          rebuiltSession = context.sessions.create(SessionId(options.sessionId), {
            seed: options.seed,
            meta: options.meta,
          });
          return { agent: { session: rebuiltSession }, dispose: async () => {} };
        },
      },
      sessions: { flush: async candidate => { assert.equal(candidate, rebuiltSession); } },
      workspaceRegistry: {
        archiveSession: async () => {},
        resolveByPath: async () => ({ attachSession: async () => {} }),
      },
      get: key => {
        if (key === "sessionTitle") {
          return {
            get: () => undefined,
            rename(candidate, title) {
              candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
            },
          };
        }
        if (key === "sessionProjectionCache") {
          return { write: async candidate => { assert.equal(candidate, rebuiltSession); cacheWrites += 1; } };
        }
        return undefined;
      },
    },
  });

  const result = await target.sync(importedBinding);

  assert.equal(result.rebuiltSessionId, expectedSessionId);
  assert.equal(result.rebuildReason, "codex-request-header-drift");
  assert.deepEqual(replaced, {
    oldSessionId: "codex-open-sync-model",
    newSessionId: expectedSessionId,
  });
  assert.deepEqual(rebuiltSession.requestHeader()?.config, {
    provider: "relay-codex",
    model: "gpt-original",
    reasoningEffort: "low",
  });
  assert.equal(rebuiltSession.deriveMessages().length, 2);
  assert.equal(cacheWrites, 1);
  assert.equal(sessionEvents(rebuiltSession).every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), true);
  await context.fiber.dispose();
});

test("open-time sync rebuilds a polluted imported DSH Session from Codex history", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const oldSession = context.sessions.create(SessionId("codex-open-sync-dirty"), {
    meta: { cwd: "/workspace/relay" },
  });
  appendCodexRequestHeader(oldSession);
  projectCodexHistory(oldSession, [sourceTurn("initial-turn", "initial question", "initial answer")]);
  appendDshFailedTurn(oldSession, 2);

  const source = thread({
    turns: [
      sourceTurn("initial-turn", "initial question", "initial answer"),
      sourceTurn("external-turn", "external question", "external answer"),
    ],
  });
  const importedBinding = {
    ...binding("codex-open-sync-dirty"),
    importState: "committed",
  };
  const expectedSessionId = rebuiltSessionId(importedBinding.threadId, importedBinding.sessionId);
  let createdOptions;
  let rebuiltSession;
  let replaced;
  let archived;
  let attached;
  let detached;
  let cacheWrites = 0;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    logger: { info() {} },
    adapter: {
      replaceImportedSession(oldSessionId, newSessionId) {
        replaced = { oldSessionId: String(oldSessionId), newSessionId: String(newSessionId) };
        return { ...importedBinding, sessionId: String(newSessionId) };
      },
    },
    ctx: {
      agents: {
        get: id => String(id) === String(oldSession.id) ? { session: oldSession } : undefined,
        create: async (options) => {
          createdOptions = options;
          rebuiltSession = context.sessions.create(SessionId(options.sessionId), {
            seed: options.seed,
            meta: options.meta,
          });
          return { agent: { session: rebuiltSession }, dispose: async () => {} };
        },
      },
      sessions: { flush: async candidate => { assert.equal(candidate, rebuiltSession); } },
      workspaceRegistry: {
        archiveSession: async sessionId => { archived = String(sessionId); },
        resolveByPath: async (cwd) => ({
          attachSession: async sessionId => { attached = { cwd, sessionId: String(sessionId) }; },
          detachSession: async sessionId => { detached = { cwd, sessionId: String(sessionId) }; },
        }),
      },
      get: key => {
        if (key === "sessionTitle") {
          return {
            get: candidate => sessionEvents(candidate).findLast(event => event.type === "session/title"),
            rename(candidate, title) {
              candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
            },
          };
        }
        if (key === "sessionProjectionCache") {
          return { write: async candidate => { assert.equal(candidate, rebuiltSession); cacheWrites += 1; } };
        }
        return undefined;
      },
    },
  });

  const result = await target.sync(importedBinding);

  assert.equal(result.rebuiltSessionId, expectedSessionId);
  assert.equal(result.rebuiltFromSessionId, "codex-open-sync-dirty");
  assert.equal(result.rebuildReason, "dsh-runtime-error-turn");
  assert.deepEqual(replaced, {
    oldSessionId: "codex-open-sync-dirty",
    newSessionId: expectedSessionId,
  });
  assert.equal(createdOptions.sessionId, expectedSessionId);
  assert.equal(archived, "codex-open-sync-dirty");
  assert.deepEqual(attached, { cwd: "/workspace/relay", sessionId: expectedSessionId });
  assert.deepEqual(detached, { cwd: "/workspace/relay", sessionId: "codex-open-sync-dirty" });
  assert.equal(cacheWrites, 1);
  assert.deepEqual(rebuiltSession.requestHeader()?.config, {
    provider: "relay-codex",
    model: "codex-test",
  });
  assert.deepEqual(rebuiltSession.deriveMessages().map(message => String(message.id)), [
    "codex:initial-turn:user:userMessage-0-0",
    "codex:initial-turn:assistant:agentMessage-0-1",
    "codex:external-turn:user:userMessage-0-0",
    "codex:external-turn:assistant:agentMessage-0-1",
  ]);
  const rebuiltText = rebuiltSession.deriveMessages().flatMap(message => message.content
    .filter(block => block.type === "text").map(block => block.text)).join("\n");
  assert.equal(rebuiltText.includes("dirty question"), false);
  assert.equal(sessionEvents(rebuiltSession).every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)), true);
  await context.fiber.dispose();
});

test("rebuild commits the imported binding only after the replacement is durable and attached", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const oldSession = context.sessions.create(SessionId("codex-rebuild-order"), {
    meta: { cwd: "/workspace/relay" },
  });
  appendCodexRequestHeader(oldSession);
  projectCodexHistory(oldSession, [sourceTurn("initial-turn", "initial question", "initial answer")]);
  appendDshFailedTurn(oldSession, 2);

  const source = thread({ turns: [sourceTurn("initial-turn", "initial question", "initial answer")] });
  const importedBinding = { ...binding("codex-rebuild-order"), importState: "committed" };
  const order = [];
  let rebuiltSession;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    logger: { info() {}, warn() {} },
    adapter: {
      replaceImportedSession(oldSessionId, newSessionId) {
        order.push("replace-binding");
        assert.equal(order.includes("attach-new"), true);
        return { ...importedBinding, sessionId: String(newSessionId) };
      },
    },
    ctx: {
      agents: {
        get: id => String(id) === String(oldSession.id) ? { session: oldSession } : undefined,
        create: async options => {
          order.push("create-new");
          rebuiltSession = context.sessions.create(SessionId(options.sessionId), {
            seed: options.seed,
            meta: options.meta,
          });
          return { agent: { session: rebuiltSession }, dispose: async () => {} };
        },
      },
      sessions: { flush: async () => { order.push("flush-new"); } },
      workspaceRegistry: {
        resolveByPath: async () => ({
          attachSession: async () => { order.push("attach-new"); },
          detachSession: async () => { throw new Error("cleanup detach failed"); },
        }),
        archiveSession: async () => { throw new Error("cleanup archive failed"); },
      },
      get: key => {
        if (key === "sessionTitle") {
          return {
            get: () => undefined,
            rename(candidate, title) {
              candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
            },
          };
        }
        if (key === "sessionProjectionCache") {
          return { write: async () => { order.push("cache-new"); } };
        }
        return undefined;
      },
    },
  });

  const result = await target.sync(importedBinding);

  assert.equal(result.rebuiltFromSessionId, "codex-rebuild-order");
  assert.deepEqual(order.slice(0, 5), [
    "create-new",
    "flush-new",
    "cache-new",
    "attach-new",
    "replace-binding",
  ]);
  await context.fiber.dispose();
});

test("rebuild loads a durable replacement without publishing an Agent lifecycle", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const oldSession = context.sessions.create(SessionId("codex-rebuild-retry"), {
    meta: { cwd: "/workspace/relay" },
  });
  appendCodexRequestHeader(oldSession);
  appendDshFailedTurn(oldSession, 1);
  const source = thread({ turns: [sourceTurn("surviving-turn", "source question", "source answer")] });
  const importedBinding = { ...binding("codex-rebuild-retry"), importState: "committed" };
  const replacementId = rebuiltSessionId(importedBinding.threadId, importedBinding.sessionId);
  const replacement = context.sessions.prepare(SessionId(replacementId), {
    seed: buildCodexHistorySeed(source.turns, source.updatedAt, {
      terminalOnly: true,
      requestConfig: { provider: "relay-codex", model: "codex-test" },
    }),
    meta: { cwd: "/workspace/relay" },
  });
  let loaded = 0;
  let appended = 0;
  let replaced = 0;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    logger: { info() {}, warn() {} },
    adapter: {
      replaceImportedSession(oldSessionId, newSessionId) {
        replaced += 1;
        return { ...importedBinding, sessionId: String(newSessionId) };
      },
    },
    ctx: {
      agents: {
        get: id => String(id) === String(oldSession.id) ? { session: oldSession } : undefined,
        create: async () => { throw new Error(`session "${replacementId}" already exists`); },
      },
      sessions: {
        get: () => undefined,
        prepare: (id, options) => context.sessions.prepare(id, options),
        flush: async () => { throw new Error("a durable replacement must stay unpublished"); },
      },
      sessionPersistence: {
        load: async id => {
          assert.equal(String(id), replacementId);
          loaded += 1;
          return { meta: structuredClone(replacement.header), events: structuredClone(sessionEvents(replacement)) };
        },
        append: async (id, events) => {
          assert.equal(String(id), replacementId);
          appended += events.length;
        },
      },
      workspaceRegistry: {
        archiveSession: async () => {},
        resolveByPath: async () => ({ attachSession: async () => {}, detachSession: async () => {} }),
      },
      get: key => {
        if (key === "sessionTitle") {
          return {
            get: () => undefined,
            rename(candidate, title) {
              candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
            },
          };
        }
        if (key === "sessionProjectionCache") return { write: async () => {} };
        return undefined;
      },
    },
  });

  const result = await target.sync(importedBinding);

  assert.equal(result.rebuiltSessionId, replacementId);
  assert.equal(loaded, 1);
  assert.equal(appended, 1);
  assert.equal(replaced, 1);
  assert.deepEqual(replacement.deriveMessages().map(message => String(message.id)), [
    "codex:surviving-turn:user:userMessage-0-0",
    "codex:surviving-turn:assistant:agentMessage-0-1",
  ]);
  await context.fiber.dispose();
});

test("rebuild reuses a live replacement candidate instead of trying to create it again", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const oldSession = context.sessions.create(SessionId("codex-rebuild-live-retry"), {
    meta: { cwd: "/workspace/relay" },
  });
  appendCodexRequestHeader(oldSession);
  appendDshFailedTurn(oldSession, 1);
  const source = thread({ turns: [sourceTurn("surviving-turn", "source question", "source answer")] });
  const importedBinding = { ...binding("codex-rebuild-live-retry"), importState: "committed" };
  const replacementId = rebuiltSessionId(importedBinding.threadId, importedBinding.sessionId);
  const replacement = context.sessions.create(SessionId(replacementId), {
    seed: buildCodexHistorySeed(source.turns, source.updatedAt, {
      terminalOnly: true,
      requestConfig: { provider: "relay-codex", model: "codex-test" },
    }),
    meta: { cwd: "/workspace/relay" },
  });
  let replaced = 0;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    logger: { info() {}, warn() {} },
    adapter: {
      replaceImportedSession(oldSessionId, newSessionId) {
        replaced += 1;
        return { ...importedBinding, sessionId: String(newSessionId) };
      },
    },
    ctx: {
      agents: {
        get: id => {
          if (String(id) === String(oldSession.id)) return { session: oldSession };
          if (String(id) === replacementId) return { session: replacement };
          return undefined;
        },
        create: async () => { throw new Error(`cannot prepare session "${replacementId}" while it is live`); },
      },
      sessions: { flush: async candidate => { assert.equal(candidate, replacement); } },
      workspaceRegistry: {
        archiveSession: async () => {},
        resolveByPath: async () => ({ attachSession: async () => {}, detachSession: async () => {} }),
      },
      get: key => {
        if (key === "sessionTitle") {
          return {
            get: () => undefined,
            rename(candidate, title) {
              candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
            },
          };
        }
        if (key === "sessionProjectionCache") return { write: async () => {} };
        return undefined;
      },
    },
  });

  const result = await target.sync(importedBinding);

  assert.equal(result.rebuiltSessionId, replacementId);
  assert.equal(replaced, 1);
  await context.fiber.dispose();
});

test("open-time sync rebuilds when the imported DSH Session is missing", async () => {
  const context = new Context();
  await context.plugin(SessionStore);
  const source = thread({
    turns: [sourceTurn("surviving-turn", "source question", "source answer")],
  });
  const importedBinding = {
    ...binding("codex-open-sync-missing"),
    importState: "committed",
  };
  const expectedSessionId = rebuiltSessionId(importedBinding.threadId, importedBinding.sessionId);
  let replaced;
  let rebuiltSession;
  const target = new DshCodexImportTarget({
    runtime: { readThread: async () => structuredClone(source) },
    logger: { info() {} },
    adapter: {
      replaceImportedSession(oldSessionId, newSessionId) {
        replaced = { oldSessionId: String(oldSessionId), newSessionId: String(newSessionId) };
        return { ...importedBinding, sessionId: String(newSessionId) };
      },
    },
    ctx: {
      agents: {
        get: () => undefined,
        create: async (options) => {
          rebuiltSession = context.sessions.create(SessionId(options.sessionId), {
            seed: options.seed,
            meta: options.meta,
          });
          return { agent: { session: rebuiltSession }, dispose: async () => {} };
        },
      },
      sessionPersistence: {
        load: async () => { throw new Error('session "codex-open-sync-missing" not found'); },
      },
      sessions: { flush: async candidate => { assert.equal(candidate, rebuiltSession); } },
      workspaceRegistry: {
        archiveSession: async () => { throw new Error("cannot archive session 'codex-open-sync-missing': live sessions and session persistence hold no such session"); },
        resolveByPath: async () => ({ attachSession: async () => {} }),
      },
      get: key => {
        if (key === "sessionTitle") {
          return {
            get: () => undefined,
            rename(candidate, title) {
              candidate.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
            },
          };
        }
        if (key === "sessionProjectionCache") {
          return { write: async candidate => { assert.equal(candidate, rebuiltSession); } };
        }
        return undefined;
      },
    },
  });

  const result = await target.sync(importedBinding);

  assert.equal(result.rebuiltSessionId, expectedSessionId);
  assert.equal(result.rebuiltFromSessionId, "codex-open-sync-missing");
  assert.equal(result.rebuildReason, "dsh-session-not-found");
  assert.deepEqual(replaced, {
    oldSessionId: "codex-open-sync-missing",
    newSessionId: expectedSessionId,
  });
  assert.deepEqual(rebuiltSession.deriveMessages().map(message => String(message.id)), [
    "codex:surviving-turn:user:userMessage-0-0",
    "codex:surviving-turn:assistant:agentMessage-0-1",
  ]);
  await context.fiber.dispose();
});

function thread(overrides = {}) {
  return {
    id: "codex-thread",
    name: null,
    preview: "source preview",
    cwd: "/workspace/relay",
    createdAt: 1,
    updatedAt: 2,
    turns: [],
    ...overrides,
  };
}

function binding(sessionId) {
  return {
    sessionId,
    threadId: "codex-thread",
    config: { model: "codex-test", cwd: "/workspace/relay" },
    bindingMode: "imported",
    importState: "reserved",
  };
}

function sourceTurn(id, user, assistant, status = "completed") {
  return {
    id,
    status,
    items: [
      { type: "userMessage", content: [{ type: "text", text: user }] },
      { type: "agentMessage", text: assistant },
    ],
  };
}

function appendDshOwnedTurn(session, turn, codexTurnId) {
  session.append("turn/start", { turn });
  session.append("user/message", freezeMessage({
    id: MessageId(`dsh:${turn}:user`),
    role: "user",
    content: [{ type: "text", text: "owned question" }],
    source: { kind: "user" },
  }), { surfaceOp: "append" });
  session.append("step/start", { turn, step: 1 });
  session.append("assistant/message", {
    turn,
    step: 1,
    stream: [],
    message: freezeMessage({
      id: MessageId(`dsh:${turn}:assistant`),
      role: "assistant",
      content: [{ type: "text", text: "owned answer" }],
      source: {
        kind: "model",
        provider: "relay-codex",
        model: "codex-test",
        replayState: { response: { threadId: "codex-thread", turnId: codexTurnId } },
      },
    }),
  }, { surfaceOp: "append" });
  session.append("step/end", { turn, step: 1 });
  session.append("turn/end", { turn, reason: { kind: "completed" } });
}

function appendCodexRequestHeader(session, overrides = {}) {
  session.append("request/header", {
    header: {
      config: {
        provider: "relay-codex",
        model: overrides.model ?? "codex-test",
        ...(overrides.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
      },
    },
    reason: overrides.reason ?? "initial",
  });
}

function appendDshFailedTurn(session, turn) {
  session.append("turn/start", { turn });
  session.append("user/message", freezeMessage({
    id: MessageId(`dsh:${turn}:user`),
    role: "user",
    content: [{ type: "text", text: "dirty question" }],
    source: { kind: "user" },
  }), { surfaceOp: "append" });
  session.append("turn/end", {
    turn,
    reason: {
      kind: "error",
      error: { message: "dirty active writer", code: "CODEX_THREAD_ACTIVE_WRITER" },
    },
  });
}
