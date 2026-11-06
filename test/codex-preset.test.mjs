import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import AgentPresets from "@deepseek-ai/dsh-agent-preset-registry";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import * as presets from "../preset.js";

const source = fileURLToPath(new URL("../presets/relay-codex", import.meta.url));
const missing = () => new RemoteError("agent-preset/not-found", "missing", { agentPreset: "relay-codex", available: [] });
const deferred = () => Promise.withResolvers();

async function fixture(context) {
  const home = await mkdtemp(join(tmpdir(), "codex-managed-preset-"));
  const ctx = new Context();
  context.after(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); });
  return { ctx, home };
}

test("the connector publishes the same timed plugin rows to modern and legacy presets before becoming ready", async context => {
  const { ctx, home } = await fixture(context);
  let definition;
  let retired = 0;
  const started = deferred(), release = deferred();
  ctx.provide("agentPresets", {
    readDocument: async () => { if (!definition) throw missing(); return { content: JSON.stringify(definition.plugins) }; },
    register: async value => { definition = value; started.resolve(); await release.promise; return () => { retired++; }; },
  });
  let ready = false;
  const starting = ctx.plugin(async scope => {
    await presets.installCodexPresets(scope, source, { home });
    assert.equal(definition?.id, "relay-codex");
    ready = true;
  });
  await started.promise;
  assert.equal(ready, false, "connector readiness must wait for its preset registration");
  release.resolve();
  const connector = await starting;
  assert.equal(ready, true);
  const legacy = JSON.parse(await readFile(join(home, ".agent-presets/relay-codex/agent.cordis.yml"), "utf8"));
  assert.deepEqual(legacy, definition.plugins);
  assert.deepEqual(legacy, [{ name: "@deepseek-ai/dsh-tool-ask-user", config: { mode: "timed" } }]);
  await connector.dispose();
  assert.equal(retired, 1);
});

test("a host without the modern registry finishes activation and still installs the legacy preset", async context => {
  const { ctx, home } = await fixture(context);
  const connector = await ctx.plugin(scope => presets.installCodexPresets(scope, source, { home }).then(() => {}));
  assert.equal(connector.state, 2);
  assert.equal(JSON.parse(await readFile(join(home, ".agent-presets/relay-codex/agent.cordis.yml"), "utf8"))[0].config.mode, "timed");
});

test("an unmanaged legacy preset is refused without changing its files or registering a replacement", async context => {
  const { ctx, home } = await fixture(context);
  const target = join(home, ".agent-presets/relay-codex");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "agent.cordis.yml"), "user composition\n");
  let writes = 0;
  ctx.provide("agentPresets", { register: async () => { writes++; return () => {}; } });
  await assert.rejects(presets.installCodexPresets(ctx, source, { home }), /is not Relay-managed/);
  assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "user composition\n");
  assert.equal(writes, 0);
});

test("existing explicit declarations, including an empty composition, remain owned by the user", async context => {
  for (const content of ["[]", "- name: user-custom-tool"]) {
    const { ctx, home } = await fixture(context);
    let writes = 0;
    ctx.provide("agentPresets", {
      readDocument: async () => ({ agentPreset: "relay-codex", content }),
      register: async () => { writes++; return () => {}; },
    });
    await ctx.plugin(scope => presets.installCodexPresets(scope, source, { home }).then(() => {}));
    assert.equal(writes, 0);
  }
});

test("a declaration winning the startup race is preserved and re-read", async context => {
  const { ctx, home } = await fixture(context);
  let reads = 0;
  ctx.provide("agentPresets", {
    readDocument: async () => { if (++reads === 1) throw missing(); return { content: "custom winner" }; },
    register: async () => { throw new Error("Duplicate agent preset: relay-codex"); },
  });
  await ctx.plugin(scope => presets.installCodexPresets(scope, source, { home }).then(() => {}));
  assert.equal(reads, 2);
});

test("disposing a connector during registration retires the late declaration exactly once", async context => {
  assert.equal(typeof presets.installCodexPresets, "function");
  const { ctx, home } = await fixture(context);
  const started = deferred(), release = deferred();
  let retired = 0;
  ctx.provide("agentPresets", {
    readDocument: async () => { throw missing(); },
    register: async () => { started.resolve(); await release.promise; return () => { retired++; }; },
  });
  const connector = ctx.plugin(scope => presets.installCodexPresets(scope, source, { home }).then(() => {}));
  await started.promise;
  const disposed = connector.dispose();
  release.resolve();
  await disposed;
  assert.equal(retired, 1);
});

test("unexpected registry failures remain startup errors", async context => {
  const { ctx, home } = await fixture(context);
  ctx.provide("agentPresets", {
    readDocument: async () => { throw new Error("registry unavailable"); },
    register: async () => { throw new Error("must not write"); },
  });
  await assert.rejects(async () => { await ctx.plugin(scope => presets.installCodexPresets(scope, source, { home }).then(() => {})); }, /registry unavailable/);
});

test("the real DSH registry activates the real timed question plugin through the host Loader", async context => {
  const { ctx, home } = await fixture(context);
  const require = createRequire(import.meta.url);
  const dshRequire = createRequire(require.resolve("@deepseek-ai/dsh/package.json"));
  const hostRequire = createRequire(dshRequire.resolve("@deepseek-ai/dsh-base"));
  const askUser = await import(hostRequire.resolve("@deepseek-ai/dsh-tool-ask-user"));
  const registered = [];
  ctx.provide("tools", { register(tool) { registered.push(tool); return () => {}; } });
  ctx.provide("userQuestions", {});
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(source, "../../")).href });
  ctx.loader.builtins["@deepseek-ai/dsh-tool-ask-user"] = askUser;
  // Preset trees share the host resolver. Supply its real package as the
  // isolated host's builtin, avoiding a registry download or module copy.
  ctx.loader.internal = { import: async name => {
    if (ctx.loader.builtins[name]) return ctx.loader.builtins[name];
    throw new Error(`Unexpected fixture import ${name}`);
  } };
  await ctx.plugin(SessionProjections);
  await ctx.plugin(AgentPresets, { default: "relay-codex" });
  await ctx.plugin(scope => presets.installCodexPresets(scope, source, { home }).then(() => {}));
  assert.equal((await ctx.agentPresets.resolve("relay-codex")).id, "relay-codex");
  assert.equal((await ctx.agentPresets.resolve("relay-codex")).broken, undefined);
  const tool = registered.find(value => value.name === "ask_user_question");
  assert.equal(tool?.parameters.properties.timeout.type, "integer");
});
