import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { detectImageMediaType } from "./codex-image.js";

const MAX_CODEX_INPUT_IMAGE_BYTES = 25 * 1024 * 1024;

export async function materializeCodexAttachment(block, attachments, signal) {
  signal?.throwIfAborted();
  const ref = block?.attachment;
  const id = String(ref?.attachmentId ?? "").trim();
  if (!ref || !id) {
    throw codexImageInputError(
      "Codex cannot read an image without a DSH attachment reference.",
      "CODEX_IMAGE_INPUT_INVALID",
    );
  }
  if (typeof attachments?.readImage !== "function") {
    throw codexImageInputError(
      `Codex cannot read image attachment ${id}: the DSH attachment service is unavailable.`,
      "CODEX_IMAGE_ATTACHMENTS_UNAVAILABLE",
    );
  }

  let stored;
  try {
    stored = await attachments.readImage(ref, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw codexImageInputError(
      `Codex cannot read image attachment ${id}: the attachment is missing or corrupt.`,
      "CODEX_IMAGE_READ_FAILED",
      error,
    );
  }
  signal?.throwIfAborted();

  if (!(stored?.data instanceof Uint8Array)
    || stored.data.length === 0
    || stored.data.length > MAX_CODEX_INPUT_IMAGE_BYTES) {
    throw codexImageInputError(
      `Codex cannot read image attachment ${id}: the attachment store returned invalid image data.`,
      "CODEX_IMAGE_READ_FAILED",
    );
  }
  const data = Buffer.from(stored.data);
  const mediaType = detectImageMediaType(data);
  if (!mediaType) {
    throw codexImageInputError(
      `Codex cannot read image attachment ${id}: the encoded image type is unsupported.`,
      "CODEX_IMAGE_TYPE_UNSUPPORTED",
    );
  }

  const digest = createHash("sha256").update(data).digest("hex");
  const root = codexInputImageRoot();
  const path = join(root, `${digest}.${extensionFor(mediaType)}`);
  try {
    await persistContentAddressedImage(root, path, data, digest, signal);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (String(error?.code ?? "").startsWith("CODEX_IMAGE_")) throw error;
    throw codexImageInputError(
      "Codex could not store the verified DSH input image.",
      "CODEX_IMAGE_CACHE_WRITE_FAILED",
      error,
    );
  }
  return {
    path,
    fsPath: path,
    label: ref.name ?? block.name ?? `image.${extensionFor(mediaType)}`,
  };
}

export function codexInputImageRoot() {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return resolve(codexHome, "dsh-input-images");
}

async function persistContentAddressedImage(root, path, data, digest, signal) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  signal?.throwIfAborted();
  const temporary = join(root, `.${digest}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    try {
      await link(temporary, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingStat = await lstat(path);
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw codexImageInputError(
          "Codex input image cache failed content verification.",
          "CODEX_IMAGE_CACHE_INVALID",
          error,
        );
      }
      const existing = await readFile(path);
      const existingDigest = createHash("sha256").update(existing).digest("hex");
      if (existingDigest !== digest) {
        throw codexImageInputError(
          "Codex input image cache failed content verification.",
          "CODEX_IMAGE_CACHE_INVALID",
          error,
        );
      }
    }
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(error => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function extensionFor(mediaType) {
  if (mediaType === "image/jpeg") return "jpg";
  return mediaType.slice("image/".length);
}

function codexImageInputError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}
