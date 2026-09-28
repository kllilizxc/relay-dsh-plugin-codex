import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("Codex preserves the official layout and owns no workbench feature", async () => {
  const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
  const client = await readFile(join(root, "src/client/index.ts"), "utf8");
  assert.doesNotMatch(patch, /ui-layout|relay-(?:workbench|files|terminal)-host/);
  assert.doesNotMatch(client, /workbench|WorkspaceFiles|WebTerminal/);
});

test("Codex contributes terminal transport only through the optional v1 Cordis service", async () => {
  const host = await readFile(join(root, "dsh-plugin.js"), "utf8");
  assert.match(host, /ctx\.inject\(\["relayTerminalProviders"\]/);
  assert.match(host, /apiVersion !== 1/);
  assert.doesNotMatch(host, /@relay\/dsh-plugin-(?:workbench|files|terminal)/);
});

test("Codex has no runtime dependency on another Relay package", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith("@relay/")), []);
});
