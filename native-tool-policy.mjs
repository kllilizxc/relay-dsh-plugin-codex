// This is a trusted host policy, separate from the model-visible DSH tools.
// App Server cannot enforce arbitrary subsets of read operations with its shell.
// Only accept the complete host read grant; never widen partial grants.
const READ_TOOLS = new Set(["read", "read_image", "glob", "grep"]);

export function nativeToolsRestricted(allowlist) {
  if (allowlist === undefined) return false;
  if (!Array.isArray(allowlist) || (allowlist.length > 0 &&
    (allowlist.some(tool => !READ_TOOLS.has(tool)) || [...READ_TOOLS].some(tool => !allowlist.includes(tool))))) {
    throw new Error("Relay Codex supports only empty or complete read-only nativeToolAllowlist values; other partial native tool grants are unsupported");
  }
  return true;
}

export const NATIVE_TOOL_RESTRICTION_INSTRUCTIONS = "This session's host grant disables native Codex tools. Use only the provided dynamic DSH tools; native shell, file, network, MCP, plugin, and subagent tools are unavailable.";

export const READ_ONLY_NATIVE_TOOL_INSTRUCTIONS = "This session's host grant allows native file reads only, through the read-only shell sandbox and, when enabled, view_image. Do not write files or use network, MCP, plugin, or subagent tools. Dynamic DSH tools remain subject to their host grants.";

export function threadInstructions(instructions, restricted, allowlist = []) {
  return [instructions, restricted ? (allowlist.length ? READ_ONLY_NATIVE_TOOL_INSTRUCTIONS : NATIVE_TOOL_RESTRICTION_INSTRUCTIONS) : undefined]
    .filter(text => typeof text === "string" && text.trim()).join("\n\n") || null;
}

const EXECUTION_FEATURES = [
  "shell_tool", "unified_exec", "code_mode", "code_mode_host",
  "multi_agent", "multi_agent_v2", "apps", "plugins", "remote_plugin",
  "browser_use", "browser_use_external", "browser_annotation_api",
  "browser_use_full_cdp_access", "computer_use", "in_app_browser",
  "in_app_local_automation", "image_generation", "view_image", "sleep_tool",
  "skill_search", "skill_mcp_dependency_install", "workspace_dependencies",
  "request_permissions_tool", "default_mode_request_user_input", "goals",
  "token_budget", "standalone_web_search", "hooks",
];

export async function restrictedNativeConfig(client, cwd, allowlist = []) {
  nativeToolsRestricted(allowlist);
  // Enumerate the effective project configuration every time. Disabling only
  // dynamicTools leaves inherited MCP servers and plugins available to Codex.
  const effective = await client.request("config/read", { cwd, includeLayers: false });
  return {
    ...Object.fromEntries(EXECUTION_FEATURES.map(feature => [`features.${feature}`, false])),
    ...(allowlist.length ? {
      "features.shell_tool": true,
      "features.unified_exec": true,
      "features.view_image": allowlist.includes("read_image"),
    } : {}),
    web_search: "disabled",
    mcp_servers: Object.fromEntries(
      Object.keys(effective.config.mcp_servers ?? {}).map(name => [name, { enabled: false }]),
    ),
    plugins: Object.fromEntries(
      Object.keys(effective.config.plugins ?? {}).map(name => [name, { enabled: false }]),
    ),
  };
}

// DSH providerInfo currently discards extra fields. Keep the capability tied to
// the registered adapter's lifetime so host admission cannot outlive enforcement.
const NATIVE_GRANT_SUPPORT = Symbol.for("worka.nativeToolGrantSupport.v1");
export function registerNativeGrantAdapter(ctx, provider, adapter) {
  const llm = ctx.llm;
  let support = llm[NATIVE_GRANT_SUPPORT];
  if (support === undefined) {
    support = new Map();
    llm[NATIVE_GRANT_SUPPORT] = support;
  }
  if (!(support instanceof Map)) throw new Error("Invalid native tool grant capability registry");
  if (support.has(provider)) throw new Error(`Native tool grant capability already registered for ${provider}`);
  const token = Object.freeze({ nativeToolAllowlist: true });
  // Adapter registration is also a Cordis effect, and can be torn down before
  // the plugin's own deferred cleanup. Keep this listener on the root fiber so
  // any topology change revokes admission even in that order. Later unrelated
  // topology changes also revoke it; that is intentionally fail-closed.
  const revoke = () => { if (support.get(provider) === token) support.delete(provider); };
  const disposeListener = ctx.root.on("llm/adapters-updated", revoke, { global: true, prepend: true });
  let disposeAdapter;
  try {
    disposeAdapter = llm.registerAdapter([provider], adapter);
    support.set(provider, token);
  } catch (error) {
    disposeListener();
    throw error;
  }
  return () => {
    revoke();
    disposeListener();
    disposeAdapter();
  };
}
