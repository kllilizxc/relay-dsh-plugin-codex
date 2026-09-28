import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  codexInputImageRoot,
  materializeCodexAttachment,
} from "../codex-image-input.js";

test("DSH image bytes become private content-addressed Codex input files", async (context) => {
  const directory = await isolatedCodexHome(context);
  const data = pngFixture("single-shapes");
  const digest = createHash("sha256").update(data).digest("hex");
  const reads = [];
  const attachments = {
    async readImage(ref, signal) {
      signal?.throwIfAborted();
      reads.push(ref.attachmentId);
      return { ref: { ...ref, mediaType: "image/jpeg" }, data: Uint8Array.from(data) };
    },
  };
  const block = {
    type: "image",
    attachment: { attachmentId: `sha256:${digest}`, mediaType: "image/jpeg", name: "clipboard.jpg" },
  };

  const [first, second] = await Promise.all([
    materializeCodexAttachment(block, attachments),
    materializeCodexAttachment(block, attachments),
  ]);

  assert.deepEqual(reads, [`sha256:${digest}`, `sha256:${digest}`]);
  assert.equal(first.path, join(codexInputImageRoot(), `${digest}.png`));
  assert.deepEqual(second, first);
  assert.deepEqual(await readFile(first.path), data);
  if (platform() !== "win32") {
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(codexInputImageRoot())).mode & 0o777, 0o700);
  }
  assert.deepEqual((await readdir(codexInputImageRoot())).sort(), [`${digest}.png`]);
  assert.equal(first.label, "clipboard.jpg");
  assert.equal(first.path.startsWith(directory), true);
});

test("Codex image input rejects bad attachment states with stable codes", async (t) => {
  const cases = [
    {
      name: "attachment service unavailable",
      attachments: null,
      expected: "CODEX_IMAGE_ATTACHMENTS_UNAVAILABLE",
    },
    {
      name: "attachment missing",
      attachments: { async readImage() { throw new Error("missing"); } },
      expected: "CODEX_IMAGE_READ_FAILED",
    },
    {
      name: "invalid stored data",
      attachments: { async readImage(ref) { return { ref, data: "not-bytes" }; } },
      expected: "CODEX_IMAGE_READ_FAILED",
    },
    {
      name: "unsupported encoded type",
      attachments: { async readImage(ref) { return { ref, data: Uint8Array.from(Buffer.from("not an image")) }; } },
      expected: "CODEX_IMAGE_TYPE_UNSUPPORTED",
    },
    {
      name: "oversized stored data",
      attachments: { async readImage(ref) { return { ref, data: new Uint8Array(25 * 1024 * 1024 + 1) }; } },
      expected: "CODEX_IMAGE_READ_FAILED",
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await assert.rejects(
        materializeCodexAttachment({
          type: "image",
          attachment: { attachmentId: `sha256:${basename(scenario.name)}`, mediaType: "image/png" },
        }, scenario.attachments),
        error => error.code === scenario.expected,
      );
    });
  }
});

test("Codex image input rejects a missing attachment id", async () => {
  await assert.rejects(materializeCodexAttachment({
    type: "image",
    attachment: { mediaType: "image/png" },
  }, {
    async readImage() { throw new Error("must not read malformed reference"); },
  }), error => error.code === "CODEX_IMAGE_INPUT_INVALID");
});

test("Codex image materialization honors cancellation before reading", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before image read"));
  let reads = 0;

  await assert.rejects(materializeCodexAttachment({
    type: "image",
    attachment: { attachmentId: "sha256:cancelled", mediaType: "image/png" },
  }, {
    async readImage() { reads += 1; },
  }, controller.signal), /cancelled before image read/);
  assert.equal(reads, 0);
});

test("Codex image cache write failures expose a stable error", async (context) => {
  const directory = await isolatedCodexHome(context);
  await writeFile(join(directory, "dsh-input-images"), "directory collision");
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  await assert.rejects(materializeCodexAttachment({
    type: "image",
    attachment: { attachmentId: "sha256:cache-failure", mediaType: "image/png" },
  }, {
    async readImage(ref) { return { ref, data: png }; },
  }), error => error.code === "CODEX_IMAGE_CACHE_WRITE_FAILED"
    && !error.message.includes(directory));
});

test("Codex image cache rejects content changed under an existing digest", async (context) => {
  await isolatedCodexHome(context);
  const data = pngFixture("cache-integrity");
  const block = {
    type: "image",
    attachment: { attachmentId: "sha256:cache-integrity", mediaType: "image/png" },
  };
  const attachments = {
    async readImage(ref) { return { ref, data: Uint8Array.from(data) }; },
  };
  const stored = await materializeCodexAttachment(block, attachments);
  await writeFile(stored.path, "changed after publication");

  await assert.rejects(
    materializeCodexAttachment(block, attachments),
    error => error.code === "CODEX_IMAGE_CACHE_INVALID",
  );
});

function pngFixture(label) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label),
  ]);
}

async function isolatedCodexHome(context) {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-input-images-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  context.after(async () => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
