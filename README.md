# Codex Conversations for DeepSeek Harness

This plugin adds Codex as a conversation backend in DeepSeek Harness (DSH). It runs the official Codex App Server and keeps each DSH session connected to its Codex thread.

This repository is a source fork of the MIT-licensed Relay Codex plugin at version `0.2.5-rc.1`. The original copyright notice is retained in [LICENSE](LICENSE). This fork is distributed through GitHub only; it is not an npm release.

[中文说明](README.zh.md)

## Changes in this fork

- Text-only, tool-free calls without a DSH session use an ephemeral Codex thread and release it after completion or failure.
- Switching between Codex providers preserves an explicitly selected model when that model is available.
- In a Codex session, `/` can list native Codex skills for that session's workspace. Selecting a skill inserts a native `$skill` reference; duplicate names use a path-qualified reference.

## Install from GitHub

1. Install Node.js 22.13 or newer and `pnpm`.
2. Authenticate an official Codex client, for example with `codex login`.
3. In DSH, stop the Web process and install this repository using the HTTPS clone URL shown by GitHub:

   ```sh
   dsh plugin --profile web add 'git+https://github.com/<account>/relay-dsh-plugin-codex.git#main'
   dsh web
   ```

4. Open **New Session**, choose a workspace, and select **Codex**.

The native skill menu requires a DSH build with the `inputTriggers` client service and session query service. Compatibility with every DSH version in the package's peer dependency range has not been verified for this fork.

## Development

The source, generated `lib/` artifacts, and focused tests are kept together. For a local build, point `DSH_ROOT` at a compatible DSH source checkout and run `npm run build`. Run only tests relevant to a change unless you explicitly intend a full verification run.

This repository does not contain local session data or compatibility run logs.
