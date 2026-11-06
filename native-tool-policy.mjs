// Host grants are a behavioral restriction, not an adversarial sandbox.
// DSH tools are filtered by the host; Codex native features are disabled for
// every explicit grant and the remaining process is read-only.
export function nativeToolsRestricted(allowlist) {
  if (allowlist === undefined) return false;
  if (!Array.isArray(allowlist) || allowlist.some(name => typeof name !== "string" || !name.trim()))
    throw new Error("Relay Codex requires a valid native tool allowlist");
  return true;
}

export const NATIVE_TOOL_RESTRICTION_INSTRUCTIONS = "This session has a restricted host grant. Use only the provided dynamic DSH tools; do not use native shell, file, network, MCP, plugin, or subagent tools.";
export const READ_ONLY_NATIVE_TOOL_INSTRUCTIONS = NATIVE_TOOL_RESTRICTION_INSTRUCTIONS;

export function threadInstructions(instructions, restricted) {
  return [instructions, restricted ? NATIVE_TOOL_RESTRICTION_INSTRUCTIONS : undefined]
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
  "token_budget", "standalone_web_search",
];

// Codex's PreToolUse interface is best effort: some schemas do not call it,
// and an execution failure is allowed through by Codex. The read-only sandbox
// and never-approve policy remain active independently of the hook.
const DENY_HOOK = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{try{const p=JSON.parse(s);if(String(p.tool_name||'').toLowerCase().replace(/[._:]/g,'').startsWith('dsh')){console.log('{}');return}}catch{}console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Native tools are disabled by the host grant; use the available DSH tools.'}}))})`;
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

export async function restrictedNativeConfig(client, cwd, allowlist = []) {
  nativeToolsRestricted(allowlist);
  const effective = await client.request("config/read", { cwd, includeLayers: false });
  return {
    ...Object.fromEntries(EXECUTION_FEATURES.map(feature => [`features.${feature}`, false])),
    "features.hooks": true,
    bypass_hook_trust: true,
    "hooks.PreToolUse": [{ matcher: ".*", hooks: [{ type: "command", command: `${shellQuote(process.execPath)} -e ${shellQuote(DENY_HOOK)}`, timeout: 5 }] }],
    web_search: "disabled",
    mcp_servers: Object.fromEntries(Object.keys(effective.config.mcp_servers ?? {}).map(name => [name, { enabled: false }])),
    plugins: Object.fromEntries(Object.keys(effective.config.plugins ?? {}).map(name => [name, { enabled: false }])),
  };
}
