# Codex Conversations for DeepSeek Harness

This plugin adds Codex as a conversation backend in DeepSeek Harness (DSH). It runs the official Codex App Server and keeps each DSH session connected to its Codex thread.

This repository is a source fork of the MIT-licensed Relay Codex plugin at version `0.2.5-rc.1`. The original copyright notice is retained in [LICENSE](LICENSE). This fork is distributed through GitHub only; it is not an npm release.

[中文说明](README.zh.md)

## Changes in this fork

- Text-only, tool-free calls without a DSH session use an ephemeral Codex thread and release it after completion or failure.
- Switching between Codex providers preserves an explicitly selected model when that model is available.
- In a Codex session, `/` can list native Codex skills for that session's workspace. Selecting a skill inserts a native `$skill` reference; duplicate names use a path-qualified reference.
- Adapted to DSH `0.2.1-rc.2` and React 19: native plugin `Config` for the Codex runtime setting, tool-role activity results, and durable file attachments forwarded to Codex as readable host paths. Peer ranges pin these versions.

## Install from GitHub

1. Install Node.js 22.13 or newer and `pnpm`.
2. Authenticate an official Codex client, for example with `codex login`.
3. In DSH, stop the Web process and install this repository using the HTTPS clone URL shown by GitHub:

   ```sh
   dsh plugin --profile web add 'git+https://github.com/<account>/relay-dsh-plugin-codex.git#main'
   dsh web
   ```

4. Open **New Session**, choose a workspace, and select **Codex**.

This fork targets DSH `0.2.1-rc.2` with React 19, pinned by the peer dependency ranges. The native skill menu requires a DSH build with the `inputTriggers` client service and session query service. Opening absolute file paths from final answers as buttons requires a DSH frontend whose `MarkdownText` supports path links; on stock DSH `0.2.1-rc.2` those links render as plain anchors.

## Development

### Temporary host maintenance sessions

A host may add `relayCodexEphemeral: true` to a Relay `GenerateOptions` request with an attached DSH agent, before that session's first Codex thread is created. This creates an ephemeral Codex thread while retaining the agent's tools, effective sandbox, approvals, and activity events. The flag is a namespaced host option; do not put maintenance labels in `GenerateOptions.purpose`, which selects the separate tool-free title/compaction path.

Temporary mode stays attached to the binding on later requests. Existing durable bindings cannot be converted, and temporary bindings cannot be downgraded. Detaching the agent invalidates its temporary binding immediately and releases the thread after any active turn settles; reattaching does not revive it. Relay retains the DSH-to-Codex link as a tombstone: a restart, released context, or changed tool surface fails explicitly without creating a replacement or replaying completed work. Start a new DSH session for new maintenance work.

Fresh DSH subagents inherit temporary mode from a known temporary parent using DSH's stored `origin`, `parentSession`, and `isSeeded` metadata. Native Codex subagents inherit the parent's ephemeral configuration. The bundled Codex 0.166 App Server cannot resume an ephemeral thread or fork one into another DSH session. Relay rejects inherited DSH forks when either the proven parent or the requested child is temporary and persists that blocked state, including across restarts. Seeded temporary children also fail closed when no completed Codex replay marker is available. Ordinary durable DSH forks are unchanged.

### Local verification

The source, generated `lib/` artifacts, and focused tests are kept together. For a local build, point `DSH_ROOT` at a compatible DSH source checkout and run `npm run build`. Run only tests relevant to a change unless you explicitly intend a full verification run.

This repository does not contain local session data or compatibility run logs.
