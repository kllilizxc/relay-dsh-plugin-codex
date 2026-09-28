# Codex Migration Compatibility Acceptance

## Requirement gate

A requirement is `verified` only when:

1. its specification row is `ready`;
2. at least one primary Codex case exists;
3. the latest applicable run passed;
4. all required evidence is present and linked;
5. the result identifies exact Codex, DSH, plugin, fixture, and platform versions;
6. no open failure contradicts the claimed supported version range.

## Capability group gate

A group is complete only when every P0 requirement is verified. P1 and P2 gaps must
remain visible in the report and must not be summarized as supported.

## Migration baseline gate

The plugin may claim Codex migration capability only when the P0 requirements for
all of these groups pass:

- text and multi-turn conversation;
- image input and generated artifact presentation;
- project file, shell, test, Git, approval, and question tools;
- user and project configuration;
- global, project, nested, and override `AGENTS.md` instructions;
- global and project Skills and MCP;
- installed Codex plugin discovery and invocation;
- Workspace boundaries and environment inheritance;
- existing Thread discovery, import, history, and continuation.

Small combined scenarios may be run after this gate to detect interactions, but they
do not change atomic requirement results.

