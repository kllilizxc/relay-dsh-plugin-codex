import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { codexImageRoots, importCodexGeneratedImage, importCodexImage } from "../codex-image.js";

test("Codex previews use the session workspace and Codex-owned image roots without escaping them", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "relay-codex-preview-roots-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(directory, "custom-codex");
  context.after(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  });

  const workspace = join(directory, "workspace");
  const generated = join(process.env.CODEX_HOME, "generated_images", "generated.png");
  const visualization = join(process.env.CODEX_HOME, "visualizations", "2026", "11", "05", "thread-id", "variants.png");
  const outside = join(directory, "outside", "private.png");
  await Promise.all([workspace, dirname(generated), dirname(visualization), dirname(outside)]
    .map(path => mkdir(path, { recursive: true })));
  const jpeg = await readFile(new URL("../docs/images/dsh-new-session-backends.jpg", import.meta.url));
  await Promise.all([
    writeFile(join(workspace, "preview.png"), jpeg),
    writeFile(generated, jpeg),
    writeFile(visualization, jpeg),
    writeFile(outside, jpeg),
  ]);

  const roots = codexImageRoots(workspace);
  assert.deepEqual(roots, [
    workspace,
    join(process.env.CODEX_HOME, "generated_images"),
    join(process.env.CODEX_HOME, "visualizations"),
  ]);
  const saved = [];
  const attachments = { async saveImage(image) {
    saved.push(image);
    return { attachmentId: String(saved.length), mediaType: image.mediaType };
  } };
  await importCodexImage("preview.png", roots, attachments);
  await importCodexImage(visualization, roots, attachments);
  await importCodexGeneratedImage({ id: "generated", savedPath: generated }, roots, attachments);
  assert.deepEqual(saved.map(({ name, mediaType }) => [name, mediaType]), [
    ["preview.png", "image/jpeg"],
    ["variants.png", "image/jpeg"],
    ["generated.png", "image/jpeg"],
  ]);
  for (const image of saved) assert.deepEqual(Buffer.from(image.data), jpeg);

  await assert.rejects(importCodexImage(outside, roots, attachments), /outside the Codex workspace/);
  await symlink(outside, join(workspace, "escape.png"));
  await assert.rejects(importCodexImage("escape.png", roots, attachments), /outside the Codex workspace/);
  await symlink(outside, join(dirname(visualization), "escape.png"));
  await assert.rejects(importCodexImage(join(dirname(visualization), "escape.png"), roots, attachments), /outside the Codex workspace/);
  assert.equal(saved.length, 3, "outside files and symlinks never reach attachment storage");
});
