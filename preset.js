import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as protocol from "@deepseek-ai/dsh-typert-protocol";

export const CODEX_PRESET_PLUGINS = [
  { name: "@deepseek-ai/dsh-tool-ask-user", config: { mode: "timed" } },
];

/** The connector owns its composition; explicit deployment declarations win. */
export async function installCodexPresets(ctx, source, { home } = {}) {
  const target = await installManagedPreset(source, "relay-codex", { home, plugins: CODEX_PRESET_PLUGINS });
  // An unavailable optional seam settles without blocking older hosts. When
  // present, await the child fiber so Worka sees our declaration at ready.
  await ctx.inject(["agentPresets"], async function* (scope) {
    try {
      await scope.agentPresets.readDocument("relay-codex");
      return;
    } catch (error) {
      const remoteErrorOf = Reflect.get(protocol, "remoteErrorOf");
      if (typeof remoteErrorOf !== "function" || remoteErrorOf(error)?.code !== "agent-preset/not-found") throw error;
    }
    try {
      yield await scope.agentPresets.register({
        id: "relay-codex", name: "Codex", description: "Run and resume a Codex thread in DSH.", order: 2,
        plugins: CODEX_PRESET_PLUGINS,
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Duplicate agent preset: relay-codex") throw error;
      await scope.agentPresets.readDocument("relay-codex");
    }
  });
  return target;
}

export async function installManagedPreset(source, id, { home, plugins } = {}) {
  home = resolve(home ?? (process.env.DSH_HOME?.trim() || join(homedir(), ".dsh")));
  const target = join(home, ".agent-presets", id);
  await mkdir(join(home, ".agent-presets"), { recursive: true });
  if (await exists(target)) {
    if (!await exists(join(target, ".relay-managed"))) {
      throw new Error(`Relay preset ${id} already exists and is not Relay-managed`);
    }
  } else {
    await mkdir(target, { recursive: true });
  }
  for (const file of ["agent.cordis.yml", "preset.yml", ".relay-managed"]) {
    if (file === "agent.cordis.yml" && plugins !== undefined) {
      // JSON is valid YAML; both host generations consume the same rows.
      await writeFile(join(target, file), `${JSON.stringify(plugins, null, 2)}\n`);
    } else await cp(join(source, file), join(target, file));
  }
  return target;
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
