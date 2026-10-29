import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))

test("Codex depends on and loads the neutral session import hub first", async () => {
  const source = manifest.dependencies["relay-dsh-plugin-session-import"];
  const bundled = lock.packages['node_modules/relay-dsh-plugin-session-import'];
  assert.equal(lock.packages[''].dependencies['relay-dsh-plugin-session-import'], source);
  assert.equal(bundled.version, "0.2.4-rc.1-worka-public.2");
  assert.equal(bundled.resolved, source);
  assert.equal(bundled.inBundle, true);
  assert.ok(manifest.bundleDependencies.includes("relay-dsh-plugin-session-import"));
  assert.ok(manifest.dsh.client.inject.includes("relay-dsh-plugin-session-import"));

  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /id: relay-session-import-for-codex\s+name: 'relay-dsh-plugin-session-import'/);
  assert.ok(patch.indexOf("relay-session-import-for-codex") < patch.indexOf("relay-codex-host"));
});

test("Codex contributes a provider instead of a standalone footer trigger", async () => {
  const source = await readFile(new URL("../src/client/index.ts", import.meta.url), "utf8");
  assert.match(source, /ctx\.slots\.inject\('relay\.session-import\.provider'/);
  assert.doesNotMatch(source, /id: 'relay-codex-workspace-import'/);

  const css = await readFile(new URL("../src/client/WorkspaceImportAction.module.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.trigger\s*\{/);
});
