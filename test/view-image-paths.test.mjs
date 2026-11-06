import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { CodexDshAdapter } from "../codex-adapter.js";
import { importCodexImage } from "../codex-image.js";

const dshRequire = createRequire(import.meta.resolve("@deepseek-ai/dsh/package.json"));
const { LocalAttachmentStore } = dshRequire("@deepseek-ai/dsh-attachment-local");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNQcGj4DwADRAHgEP20EAAAAABJRU5ErkJggg==", "base64");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relay-viewed-image-"));
  const workspace = join(root, "workspace"), artifacts = join(root, "external artifacts");
  await Promise.all([mkdir(workspace), mkdir(artifacts)]);
  const image = join(artifacts, "capture # 中文.png");
  await writeFile(image, png);
  const ctx = new Context();
  const attachments = new LocalAttachmentStore(ctx, { dshHome: join(root, "store") });
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  return { workspace, artifacts, image, attachments };
}

test("a sandbox-completed native imageView outside the conversation cwd becomes a readable native attachment", async t => {
  const f = await fixture(t);
  const chunks = await viewed(f, f.image);
  const image = chunks.find(chunk => chunk.block?.type === "image")?.block;
  assert.ok(image, "the native provider already admitted the exact file; cwd is not its read permission boundary");
  const results = f.events.filter(event => event.type === "tool/result");
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].data.message.content.filter(block => block.type === "image"), [image], "the tool card owns the same durable image, not just a success label");
  const saved = await f.attachments.readImage(image.attachment);
  assert.equal(saved.ref.width, 1);
  assert.equal(saved.ref.height, 1);
  assert.deepEqual(Buffer.from(saved.data), png);
});

test("native imageView file URIs preserve encoded spaces, unicode, and filename characters", async t => {
  const f = await fixture(t);
  const chunks = await viewed(f, pathToFileURL(f.image).href);
  const image = chunks.find(chunk => chunk.block?.type === "image")?.block;
  assert.ok(image);
  assert.equal(image.attachment.name, "capture # 中文.png");
  assert.deepEqual(Buffer.from((await f.attachments.readImage(image.attachment)).data), png);
});

test("root-constrained imports normalize local file URIs and still refuse files outside their roots", async t => {
  const f = await fixture(t);
  const ref = await importCodexImage(pathToFileURL(f.image).href, [f.artifacts], f.attachments);
  assert.deepEqual(Buffer.from((await f.attachments.readImage(ref)).data), png);
  await assert.rejects(importCodexImage(pathToFileURL(f.image).href, [f.workspace], f.attachments), /outside/);
});

test("a foreign thread cannot import a viewed file into the owning conversation", async t => {
  const f = await fixture(t);
  const chunks = await viewed(f, f.image, { foreign: true });
  assert.equal(chunks.some(chunk => chunk.block?.type === "image"), false);
  assert.equal(chunks.some(chunk => chunk.block?.text?.startsWith("Image preview unavailable")), false);
});

test("a completed view does not bypass attachment decoding or expose file contents on failure", async t => {
  const f = await fixture(t);
  await writeFile(f.image, "private-non-image-content");
  const chunks = await viewed(f, f.image);
  assert.equal(chunks.some(chunk => chunk.block?.type === "image"), false);
  assert.equal(chunks.some(chunk => chunk.block?.text?.startsWith("Image preview unavailable")), true);
  assert.equal(JSON.stringify(chunks).includes("private-non-image-content"), false);
});

test("a detached conversation cannot import a late imageView completion", async t => {
  const f = await fixture(t);
  const local = join(f.workspace, "local.png");
  await writeFile(local, png);
  let reads = 0;
  const save = f.attachments.saveImage.bind(f.attachments);
  f.attachments.saveImage = input => { reads++; return save(input); };
  const chunks = await viewed(f, local, { detachBeforeCompletion: true });
  assert.equal(reads, 0);
  assert.equal(chunks.some(chunk => chunk.block?.type === "image"), false);
});

test("a view finishing storage after its owner is detached is not emitted", async t => {
  const f = await fixture(t);
  const chunks = await viewed(f, f.image, { detachDuringSave: true });
  assert.equal(chunks.some(chunk => chunk.block?.type === "image"), false);
});

test("a failed import after detachment cannot append a stale preview placeholder", async t => {
  const f = await fixture(t);
  const chunks = await viewed(f, f.image, { failDuringDetach: true });
  assert.equal(chunks.some(chunk => chunk.block?.type === "image"), false);
  assert.equal(chunks.some(chunk => chunk.block?.text?.startsWith("Image preview unavailable")), false);
});

async function viewed(f, path, { foreign = false, detachBeforeCompletion = false, detachDuringSave = false, failDuringDetach = false } = {}) {
  const runtime = new EventEmitter();
  runtime.models = [{ id: "fixture" }];
  runtime.createSession = async config => ({ id: "view-thread", turns: [], ...config });
  const item = { type: "imageView", id: "view-item", path };
  runtime.sendMessage = async threadId => {
    queueMicrotask(() => {
      if (detachBeforeCompletion) adapter.detachAgent(agent.id);
      for (const method of ["item/started", "item/completed", "item/completed"]) runtime.emit("activity", {
        method, params: { threadId: foreign ? "other-thread" : threadId, turnId: "view-turn", item },
      });
      runtime.emit("activity", { method: "turn/completed", params: {
        threadId, turn: { id: "view-turn", status: "completed", items: foreign ? [] : [item] },
      } });
    });
    return { id: "view-turn", status: "inProgress", items: [] };
  };
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(), attachments: f.attachments, logger: { warn() {} } });
  f.events = [];
  const agent = { id: "view-session", ctx: {}, session: { header: { cwd: f.workspace, agentPreset: "relay-codex" }, events: [], append(type, data) { f.events.push({ type, data }); } } };
  adapter.attachAgent(agent);
  if (detachDuringSave || failDuringDetach) {
    const save = f.attachments.saveImage.bind(f.attachments);
    f.attachments.saveImage = async input => {
      const ref = await save(input);
      adapter.detachAgent(agent.id);
      if (failDuringDetach) throw new Error("store failed after detachment");
      return ref;
    };
  }
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: "relay-codex", model: "fixture", sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Show the capture." }] }],
  })) chunks.push(chunk);
  return chunks;
}
