import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexDshAdapter } from "../codex-adapter.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const imageUrl = `data:image/png;base64,${png.toString("base64")}`;

class ImageRuntime extends EventEmitter {
  constructor(item) { super(); this.item = item; this.models = [{ id: "fixture" }]; }
  async createSession(config) { return { id: "image-thread", turns: [], ...config }; }
  async sendMessage(threadId) {
    const turnId = "image-turn";
    queueMicrotask(() => {
      for (const method of ["item/started", "item/completed", "item/completed"]) {
        this.emit("activity", { method, params: { threadId, turnId, item: this.item } });
      }
      this.emit("activity", { method: "turn/completed", params: {
        threadId, turn: { id: turnId, status: "completed", items: [this.item,
          { type: "agentMessage", id: "answer", phase: "final_answer", text: "Image ready." },
        ] },
      } });
    });
    return { id: turnId, status: "inProgress", items: [] };
  }
}

async function run(item, reject = false) {
  const runtime = new ImageRuntime(item);
  const saved = [], warnings = [];
  const adapter = new CodexDshAdapter({ runtime, ready: Promise.resolve(),
    logger: { warn(...args) { warnings.push(args); } },
    attachments: { async saveImage(input) {
      if (reject) throw new Error("storage rejected /private/customer/image.png");
      saved.push(input);
      return { attachmentId: `image-${saved.length}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 };
    } },
  });
  const agent = { id: "image-session", ctx: {}, session: { header: { cwd: "/workspace", agentPreset: "relay-codex" }, events: [], append() {} } };
  adapter.attachAgent(agent);
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: "relay-codex", model: "fixture", sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Show the image." }] }],
  })) chunks.push(chunk);
  return { chunks, saved, warnings };
}

const item = { type: "dynamicToolCall", id: "tool-image", namespace: "dsh", tool: "image_fixture", status: "completed", success: true,
  contentItems: [{ type: "inputText", text: "Image metadata." }, { type: "inputImage", imageUrl },
    { type: "inputImage", imageUrl }],
};

test("dynamic tool images become native attachments once, in content order, before the final answer", async () => {
  const { chunks, saved } = await run(item);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(input => Buffer.from(input.data)), [png, png]);
  assert.deepEqual(chunks.filter(chunk => chunk.type === "block-end").map(chunk => chunk.block.type), ["image", "image", "text"]);
  assert.deepEqual(chunks.filter(chunk => chunk.block?.type === "image").map(chunk => chunk.block.attachment.attachmentId), ["image-1", "image-2"]);
  assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("failed dynamic tools do not project image output", async () => {
  const { chunks, saved } = await run({ ...item, success: false });
  assert.equal(saved.length, 0);
  assert.equal(chunks.some(chunk => chunk.block?.type === "image"), false);
});

test("unavailable dynamic images produce safe visible placeholders and keep the answer", async () => {
  const { chunks, warnings } = await run(item, true);
  assert.equal(chunks.filter(chunk => chunk.block?.text?.startsWith("Tool image preview unavailable")).length, 2);
  assert.equal(chunks.some(chunk => chunk.block?.text === "Image ready."), true);
  assert.equal(JSON.stringify({ chunks, warnings }).includes("/private/customer"), false);
});

test("remote image results never trigger a fetch and remain visible as unavailable", async () => {
  const { chunks, saved } = await run({ ...item, contentItems: [{ type: "inputImage", imageUrl: "https://example.invalid/image.png" }] });
  assert.equal(saved.length, 0);
  assert.equal(chunks.some(chunk => chunk.block?.text?.startsWith("Tool image preview unavailable")), true);
});
