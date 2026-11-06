import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import * as codexImages from "../codex-image.js";
import { CodexDshAdapter } from "../codex-adapter.js";
import { handleCodexServerRequest } from "../codex-tools.js";
import { CodexSessionRuntime } from "../session-runtime.mjs";

const requireDsh = createRequire(import.meta.resolve("@deepseek-ai/dsh/package.json"));
const { LocalAttachmentStore } = requireDsh("@deepseek-ai/dsh-attachment-local");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNQcGj4DwADRAHgEP20EAAAAABJRU5ErkJggg==", "base64");

test("DSH dynamic tool image results keep text/image/text order through the real attachment store", async (t) => {
  const attachments = await attachmentStore(t);
  const ref = await attachments.saveImage({ data: png, mediaType: "image/png", name: "preview.png" });
  const stored = await attachments.readImage(ref);
  assert.equal(ref.width, 1);
  assert.equal(ref.height, 1);
  const result = await executeImageTool({ attachments, content: [
    { type: "text", text: "before" }, { type: "image", attachment: ref }, { type: "text", text: "after" },
  ] });
  assert.deepEqual(result.responses, [["request-image", true, [
    { type: "inputText", text: "before" },
    { type: "inputImage", imageUrl: `data:${ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}` },
    { type: "inputText", text: "after" },
  ]]]);
  assert.deepEqual(result.rejections, []);
});

test("unreadable tool images fail explicitly without returning attachment JSON or private errors", async () => {
  const result = await executeImageTool({
    attachments: { async readImage() { throw new Error("private image path /private/customer.png"); } },
    content: [{ type: "image", attachment: { attachmentId: "unavailable-image", mediaType: "image/png" } }],
  });
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0][1], false);
  assert.match(result.responses[0][2], /image.*unavailable/i);
  assert.doesNotMatch(JSON.stringify(result), /private|customer|attachmentId|unavailable-image/);
  assert.deepEqual(result.rejections, []);
});

test("cancelling during an attachment read cannot send a late dynamic tool image", async () => {
  const controller = new AbortController();
  let release, reading;
  const started = new Promise(resolve => { reading = resolve; });
  const pending = executeImageTool({
    signal: controller.signal,
    attachments: { async readImage() {
      reading();
      return new Promise(resolve => { release = resolve; });
    } },
    content: [{ type: "image", attachment: { attachmentId: "cancelled-image" } }],
  });
  await started;
  controller.abort(new Error("image read cancelled"));
  release({ ref: { mediaType: "image/png" }, data: png });
  const result = await pending;
  assert.deepEqual(result.responses, []);
  assert.deepEqual(result.rejections, ["image read cancelled"]);
});

test("dynamic tool image reads recheck ownership before responding", async () => {
  const result = await executeImageTool({
    attachments: { async readImage() { return { ref: { mediaType: "image/png" }, data: png }; } },
    assertOwnership: () => { throw new Error("image request ownership revoked"); },
    content: [{ type: "image", attachment: { attachmentId: "stale-image" } }],
  });
  assert.deepEqual(result.responses, []);
  assert.deepEqual(result.rejections, ["image request ownership revoked"]);
});

test("Codex dynamic tool responses preserve media items and existing string callers", () => {
  const client = new EventEmitter();
  const responses = [];
  client.respond = (id, result) => responses.push({ id, result });
  const runtime = new CodexSessionRuntime({ client });
  const contentItems = [{ type: "inputText", text: "caption" }, { type: "inputImage", imageUrl: "data:image/png;base64,fixture" }];
  runtime.pendingRequests.set("media", { id: "media" });
  runtime.respondDynamicTool("media", true, contentItems);
  runtime.pendingRequests.set("text", { id: "text" });
  runtime.respondDynamicTool("text", true, "complete");
  assert.deepEqual(responses, [
    { id: "media", result: { success: true, contentItems } },
    { id: "text", result: { success: true, contentItems: [{ type: "inputText", text: "complete" }] } },
  ]);
  assert.equal(runtime.pendingRequests.size, 0);
});

test("current Codex inputImage content imports to durable images and round-trips through real storage", async (t) => {
  const attachments = await attachmentStore(t);
  assert.equal(typeof codexImages.importCodexDynamicToolImage, "function");
  const ref = await codexImages.importCodexDynamicToolImage({
    type: "inputImage", imageUrl: `data:image/png;base64,${png.toString("base64")}`,
  }, "tool-image", 2, attachments);
  assert.equal(ref.width, 1);
  assert.equal(ref.height, 1);
  assert.equal(ref.name, "codex-dynamic-tool-image-3.png");
  const stored = await attachments.readImage(ref);
  assert.deepEqual(Buffer.from(stored.data), png);
  assert.deepEqual(stored.ref, ref);
  await assert.rejects(codexImages.importCodexDynamicToolImage({
    type: "inputImage", imageUrl: "https://example.invalid/image.png",
  }, "remote", 0, attachments), /data URL/);
  await assert.rejects(codexImages.importCodexDynamicToolImage({
    type: "inputImage", imageUrl: `data:image/jpeg;base64,${png.toString("base64")}`,
  }, "mismatch", 0, attachments), /does not match/);
});

test("dynamic image completion and async questions coexist without duplicate cards or media in activity text", async (t) => {
  const attachments = await attachmentStore(t);
  const result = await projectToolImages({ attachments, withQuestion: true });
  const blocks = result.chunks.filter(chunk => chunk.type === "block-end").map(chunk => chunk.block);
  assert.deepEqual(blocks.map(block => block.type), ["image", "text"]);
  const stored = await attachments.readImage(blocks[0].attachment);
  assert.deepEqual(Buffer.from(stored.data), png);
  assert.equal(result.events.filter(event => event.type === "tool/call" && event.data.name === "ask_user_question").length, 1);
  assert.equal(result.events.filter(event => event.type === "tool/result").length, 2);
  assert.doesNotMatch(JSON.stringify(result.events), /data:image|imageUrl|iVBORw0KGgo/);
  assert.equal(result.chunks.at(-1).reason.kind, "stop");
});

test("cancelling while a dynamic image is being stored discards buffered images, prose, and question cards", async () => {
  const controller = new AbortController();
  let release, storing;
  const started = new Promise(resolve => { storing = resolve; });
  const pending = projectToolImages({
    signal: controller.signal, withQuestion: true,
    attachments: { async saveImage(input) {
      storing();
      await new Promise(resolve => { release = resolve; });
      return { attachmentId: "cancelled-preview", mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 };
    } },
  });
  await started;
  controller.abort(new Error("stop during image storage"));
  release();
  const result = await pending;
  assert.deepEqual({
    image: result.chunks.some(chunk => chunk.block?.type === "image"),
    prose: result.chunks.some(chunk => chunk.type === "text-delta"),
    question: result.events.some(event => event.type === "tool/call" && event.data.name === "ask_user_question"),
    finish: result.chunks.at(-1).reason.kind,
  }, { image: false, prose: false, question: false, finish: "aborted" });
});

async function attachmentStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "relay-tool-images-"));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return new LocalAttachmentStore(ctx, { dshHome: directory });
}

async function executeImageTool({ attachments, content, signal, assertOwnership = () => {} }) {
  const responses = [], rejections = [];
  const agent = { id: "image-session", ctx: { tools: { async execute() { return { isError: false, content }; } } } };
  const adapter = {
    dshSessionForInteractionThread: () => agent.id,
    dshToolName: () => "image-tool",
    captureRequestOwnership: () => ({}),
    assertRequestOwnership: assertOwnership,
    signalForInteractionThread: () => signal,
  };
  const runtime = {
    respondDynamicTool: (...args) => responses.push(args),
    rejectRequest: (_id, error) => rejections.push(error.message),
  };
  await handleCodexServerRequest({ agents: { get: () => agent }, attachments }, {
    adapter, runtime,
    request: { id: "request-image", method: "item/tool/call", params: { threadId: "thread-image", namespace: "dsh", tool: "image-tool", arguments: {} } },
  });
  return { responses, rejections };
}

async function projectToolImages({ attachments, withQuestion = false, signal }) {
  const image = { type: "dynamicToolCall", id: "coexist-image", namespace: "dsh", tool: "image_tool", status: "completed", success: true,
    contentItems: [{ type: "inputText", text: "Image caption" }, { type: "inputImage", imageUrl: `data:image/png;base64,${png.toString("base64")}` }],
  };
  const question = { type: "agentMessage", id: "coexist-question", delivery: "async", phase: "final_answer",
    text: "Choose a scope", questions: [{ title: "Choose a scope", options: ["Selected", "Manual"] }],
  };
  const answer = { type: "agentMessage", id: "coexist-answer", phase: "final_answer", text: "Independent work complete." };
  const items = [image, ...(withQuestion ? [question] : []), answer];
  const runtime = new EventEmitter();
  runtime.models = [{ id: "fixture" }];
  runtime.createSession = async config => ({ id: "coexist-thread", turns: [], ...config });
  runtime.interruptTurn = async () => {};
  runtime.sendMessage = async threadId => {
    queueMicrotask(() => {
      for (const item of items) {
        for (const method of ["item/started", "item/completed", "item/completed"]) {
          runtime.emit("activity", { method, params: { threadId, turnId: "coexist-turn", item } });
        }
      }
      runtime.emit("activity", { method: "turn/completed", params: { threadId, turn: { id: "coexist-turn", status: "completed", items } } });
    });
    return { id: "coexist-turn", status: "inProgress", items: [] };
  };
  const events = [], chunks = [];
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), attachments });
  const agent = { id: "coexist-session", ctx: {}, session: { header: { cwd: "/workspace", agentPreset: "relay-codex" }, events: [],
    append(type, data) { events.push({ type, data }); },
  } };
  adapter.attachAgent(agent);
  for await (const chunk of adapter.stream({ provider: "relay-codex", model: "fixture", sessionId: agent.id, signal,
    tools: [{ name: "ask_user_question", parameters: { type: "object", properties: { timeout: { type: "integer" } } } }],
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Show an image and ask for scope" }] }],
  })) chunks.push(chunk);
  return { events, chunks };
}
