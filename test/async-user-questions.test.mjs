import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from "@deepseek-ai/dsh-session";
import * as JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import UserQuestions from "@deepseek-ai/dsh-user-questions";
import { CodexDshAdapter } from "../codex-adapter.js";
import { appendPersistedEvents, loadPersistedSession, sessionEvents, writePersistedSession } from "../dsh-compat.mjs";

const timedTool = { name: "ask_user_question", description: "Ask the user", parameters: {
  type: "object", properties: { questions: { type: "array" }, timeout: { type: "integer" } },
} };
const question = { type: "agentMessage", id: "async-question", phase: "final_answer", delivery: "async",
  text: "Choose a scope:\n- Selected items\n- Manual items\n- Keep local",
  questions: [{ title: "Choose a scope", options: ["Selected items", "Manual items", "Keep local"] }],
};

class QuestionRuntime extends EventEmitter {
  constructor(item = question) { super(); this.item = item; this.sent = []; this.models = [{ id: 'fixture', defaultReasoningEffort: 'medium' }]; }
  async createSession(config) { return { id: "question-thread", turns: [], ...config }; }
  async sendMessage(threadId, message) {
    this.sent.push({ threadId, message });
    const turnId = `turn-${this.sent.length}`;
    queueMicrotask(() => {
      for (const method of ["item/started", "item/completed", "item/completed"]) {
        this.emit("activity", { method, params: { threadId, turnId,
          item: method === "item/started" ? { ...this.item, questions: null } : this.item,
        } });
        if (method === "item/started") this.emit("activity", { method: "item/agentMessage/delta",
          params: { threadId, turnId, itemId: this.item.id, delta: this.item.text },
        });
      }
      this.emit("activity", { method: "item/completed", params: { threadId, turnId,
        item: { type: "agentMessage", id: "independent-work", text: "Independent work finished.", phase: "final_answer" },
      } });
      this.emit("activity", { method: "turn/completed", params: { threadId,
        turn: { id: turnId, status: "completed", items: [this.item] },
      } });
    });
    return { id: turnId, status: "inProgress", items: [] };
  }
}

async function run({ tools = [timedTool], item = question, messages, session } = {}) {
  const runtime = new QuestionRuntime(item);
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve() });
  const events = [];
  const agent = { id: session?.id ?? "question-session", ctx: {}, session: session ?? {
    header: { cwd: "/workspace/question", agentPreset: "relay-codex" }, events: [],
    append(type, data, opts) { events.push({ type, data, opts }); },
  } };
  adapter.attachAgent(agent);
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: "relay-codex", model: "fixture", sessionId: agent.id,
    tools, messages: messages ?? [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Help me choose" }] }],
  })) chunks.push(chunk);
  return { runtime, events, chunks, adapter, agent };
}

test("async questions become one durable native question while the Codex turn continues", async () => {
  const { events, chunks } = await run();
  const calls = events.filter(event => event.type === "tool/call" && event.data.name === "ask_user_question");
  assert.equal(calls.length, 1, "duplicate item and turn notifications must not duplicate the question");
  const call = calls[0].data;
  assert.deepEqual(JSON.parse(call.arguments).questions, [{ id: "question-1", question: "Choose a scope",
    options: [{ label: "Selected items" }, { label: "Manual items" }, { label: "Keep local" }],
  }]);
  const result = events.find(event => event.type === "tool/result").data;
  assert.equal(result.message.role, "tool");
  assert.equal(result.message.toolCallId, call.callId);
  assert.deepEqual(JSON.parse(result.message.content[0].text), { pending: true, callId: call.callId });
  assert.equal(chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.text).join(""), "Independent work finished.");
  assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("async questions preserve free-text-only questions and every offered option", async () => {
  const item = { ...question, questions: [{ title: "Describe the missing detail" },
    { title: "Choose a scope", options: ["One", "Two", "Three", "Four"] }] };
  const { events } = await run({ item });
  const call = events.find(event => event.type === "tool/call");
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.data.arguments).questions, [
    { id: "question-1", question: "Describe the missing detail" },
    { id: "question-2", question: "Choose a scope", options: ["One", "Two", "Three", "Four"].map(label => ({ label })) },
  ]);
});

test("a host without timed questions retains the readable question instead of creating an unanswerable card", async () => {
  const { events, chunks } = await run({ tools: [] });
  assert.equal(events.some(event => event.type === "tool/call"), false);
  assert.equal(chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.text).join(""), question.text + "Independent work finished.");
});

test("an asynchronous message without questions retains its text", async () => {
  const item = { ...question, questions: null, text: "Independent notification." };
  const { events, chunks } = await run({ item });
  assert.equal(events.some(event => event.type === "tool/call"), false);
  assert.equal(chunks.filter(chunk => chunk.type === "text-delta").map(chunk => chunk.text).join(""), item.text + "Independent work finished.");
});

test("a continued question answer is sent to the original Codex thread instead of replaying the previous request", async () => {
  const answer = JSON.stringify({ kind: "answer_to_pending_question", callId: "previous-question",
    questions: [{ id: "scope", question: "Choose a scope" }], answers: [{ id: "scope", selected: ["Manual items"], custom: "only these" }],
  });
  const { runtime } = await run({ messages: [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Old request" }] },
    { role: "user", source: { kind: "user-question-reply", callId: "previous-question", outcome: "answered" }, content: [{ type: "text", text: answer }] },
  ] });
  assert.equal(runtime.sent.length, 1);
  assert.equal(runtime.sent[0].threadId, "question-thread");
  assert.equal(runtime.sent[0].message.text, answer);
});

test("the managed Codex preset installs the native timed question tool", async () => {
  const preset = await readFile(new URL("../presets/relay-codex/agent.cordis.yml", import.meta.url), "utf8");
  assert.match(preset, /@deepseek-ai\/dsh-tool-ask-user/);
  assert.match(preset, /mode: timed/);
});

for (const compression of ["none", "zstd"]) {
  test(`native async question and late reply survive ${compression} persistence and cold reopen`, async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-question-reload-"));
    const contexts = [];
    async function mount() {
      const ctx = new Context();
      contexts.push(ctx);
      await ctx.plugin(SessionStore);
      await ctx.plugin(SessionProjections);
      await ctx.plugin(UserQuestions);
      await ctx.plugin(JsonlSessionPersistence, { root, compression });
      return ctx;
    }
    try {
      const id = SessionId(`async-question-${compression}`);
      const session = Session.create(id, [], {
        ...Session.create(id).header, cwd: root, agentPreset: "relay-codex",
      });
      session.append("turn/start", { turn: 1 });
      session.append("step/start", { turn: 1, step: 1 });
      session.append("request/header", { reason: "initial", header: {
        config: { provider: "relay-codex", model: "fixture" }, tools: [timedTool],
      } });
      await run({ session });
      session.append("step/end", { turn: 1, step: 1 });
      session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      const writer = await mount();
      await writePersistedSession(writer.sessionPersistence, session.header, sessionEvents(session));
      await writer.fiber.dispose();

      const reader = await mount();
      const loaded = await loadPersistedSession(reader.sessionPersistence, id);
      assert.deepEqual(loaded.events, sessionEvents(session));
      assert.ok(loaded.events.every(event => KNOWN_SESSION_EVENT_TYPES.has(event.type)));
      const restored = Session.fromRestore(id, loaded.events, loaded.meta, loaded.inheritedEventCount ?? 0);
      reader.sessions.enter(restored);
      reader.sessions.announce(restored);
      const queued = [];
      const agent = { id, session: restored, ctx: reader, inbox: { nextStep: queued, nextTurn: [] },
        steer(message) { queued.push(message); },
      };
      reader.provide("agents", { get: candidate => candidate === id ? agent : undefined, roots: () => [agent] });
      const pending = reader.userQuestions.continued(agent);
      assert.equal(pending.length, 1);
      assert.deepEqual(pending[0].questions, [{ id: "question-1", question: "Choose a scope",
        options: ["Selected items", "Manual items", "Keep local"].map(label => ({ label })),
      }]);
      const answers = [{ id: "question-1", selected: ["Manual items"], custom: "only these" }];
      assert.equal(reader.userQuestions.answer(agent, pending[0].callId, { answers }), true);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].source.kind, "user-question-reply");
      assert.equal(queued[0].source.callId, pending[0].callId);
      assert.throws(() => reader.userQuestions.answer(agent, pending[0].callId, { answers }), { code: "REPLY_QUEUED" });
      restored.append("user/message", queued[0], { surfaceOp: "append" });
      assert.deepEqual(reader.userQuestions.continued(agent), []);
      assert.deepEqual(reader.sessionProjections.stateOf(restored, "userQuestions").questions.settled, [{
        callId: pending[0].callId, answers,
      }]);
      const forwarded = await run({ messages: restored.deriveMessages() });
      assert.equal(forwarded.runtime.sent[0].message.text, queued[0].content[0].text);

      // Re-persist the admitted reply and use a new reader, so settlement cannot
      // depend on a previous process's live question or inbox state.
      await reader.fiber.dispose();
      const finalWriter = await mount();
      await appendPersistedEvents(finalWriter.sessionPersistence, id, sessionEvents(restored, loaded.events.length));
      await finalWriter.fiber.dispose();
      const reopened = await mount();
      const final = await loadPersistedSession(reopened.sessionPersistence, id);
      const settled = Session.fromRestore(id, final.events, final.meta, final.inheritedEventCount ?? 0);
      assert.deepEqual(reopened.sessionProjections.stateOf(settled, "userQuestions").questions, {
        active: [], settled: [{ callId: pending[0].callId, answers }],
      });
    } finally {
      for (const ctx of contexts) await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
