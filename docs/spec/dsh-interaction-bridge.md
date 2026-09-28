# DSH Interaction Bridge Specification

## Scope

Codex App Server can pause a Turn to request approval for a command, file
change, or permission profile, or to ask the user a structured question. The
plugin routes those requests through the owning DSH Session so DSH remains the
authority for human interaction and conversation continuity.

## Composition contract

`approval` and `userQuestions` are required Host injections. They are provided
by sibling plugins in the official DSH composition, so listing them in the Host
plugin's exported `inject` array binds them into the Codex consumer fiber and
makes activation wait for both services.

The bridge must not read either service as an undeclared context property. It
must not make either dependency optional, and it must not bypass DSH approval or
question handling when a service is missing, cancelled, or fails. Failure is
closed: no App Server request is accepted and no protected operation executes.

## Request ownership

Every modern request carries a Codex `threadId`; legacy command and patch
requests carry the same identity as `conversationId`. The adapter normalizes
both forms and must resolve that id to one live DSH Session and Agent before
invoking a DSH interaction service. Modern `itemId` and legacy `callId` are
normalized into the same ownership slot.

Subagent requests carry the descendant Thread id rather than the root Thread id.
During the root Turn, the adapter observes `subAgentActivity.agentThreadId` as the
child of the notification's enclosing `threadId` and records that edge with the
current root binding epoch. App Server inventory can also identify the root through
shared `sessionId` and each edge through `parentThreadId`, but that durable inventory
is not authorization because it may be absent before the request or outlive the Turn.
The adapter must prove the complete acyclic observed parent chain to a currently
bound root before routing a descendant dynamic tool, approval, or question through
that root's DSH Agent.
Matching cwd, title, model, or recency is never sufficient ownership evidence.

An observed edge is valid only for its root Turn and binding epoch. Turn completion,
Agent detach, conflicting parent observations, a missing edge, or a root rebind makes
the descendant fail closed without DSH tool execution.

Approval ownership includes the DSH Session, Codex Thread, Turn, Item, App
Server request id, and binding epoch. Unknown, stale, re-bound, or unowned
requests are rejected without asking the user or executing the operation.

## Approval mapping

For command, file-change, and permission approval requests:

| DSH outcome | App Server response |
| --- | --- |
| `allowed-once` | `accept` for the current request |
| `rejected` | `decline` |
| `cancelled` | `decline` |
| `unavailable` | `decline` |

The requested command or App Server reason is shown through DSH's approval
service. The protected operation must not begin before `allowed-once` returns.
Thrown service errors reject the pending App Server request and never become an
implicit allow.

## Question mapping

For `item/tool/requestUserInput`, the bridge maps at most three Codex questions
to DSH questions, waits for `userQuestions.ask()`, and maps selected and custom
answers back to App Server. Cancellation or provider failure rejects the
pending request. Unsupported interaction methods are rejected.

## Activity presentation contract

Official DSH conversation rendering remains unmodified. New Codex runtime
activities use the official `assistant/message` (tool-call block), `tool/call`,
and `tool/result` envelopes with the plugin-owned tool name
`relay_codex_activity`. Versioned activity data travels in call arguments and
result `meta.codexActivity`. The plugin renders that name through the official
`tool.call.toolview` slot. This records work executed by Codex; it does not
register or dispatch an additional DSH tool. Calls have matching result messages,
carry the current DSH Turn/Step, and use Thread/Turn/Item-scoped call IDs.

Compatibility was checked against official DSH commit
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. Its persistence reader refuses unknown
event types unless `ignorable: true` is on the envelope, but its public
`Session.append()` does not accept that marker. Type declaration merging and
client conversation registration do not extend the persistence vocabulary.
New writes MUST NOT use `relay-codex/activity` or patch the official registry.

The legacy `relay-codex-activity` chat node remains read-only compatibility for
old logs. `scripts/repair-activity-history.mjs` defaults to dry-run; with DSH
stopped, `--write` backs up the original bytes and atomically adds only the
`ignorable: true` envelope marker to validated legacy activity events. It preserves
all sequence numbers, timestamps, payloads, and other records, handles every zstd
frame (with a separate header frame), is idempotent, and refuses malformed or
torn input. No other unknown event is made ignorable. Backups stay beside the
private session log, outside the repository.

Recovery must audit the complete configured session root without a modification
date or workspace filter. `--root <sessions-directory>` discovers canonical
plaintext/zstd logs across workspaces, excluding backups and symlinks. Batch
repair refuses to write if any log could not be inspected and rescans the root
after applying fixes; acceptance requires no unmarked legacy activity events
and no scan errors. Fixing only the first reported Session is not sufficient.

Assistant-facing text and reasoning keep using DSH's native text and reasoning
blocks. Command output, file changes, image views/generations, MCP tool calls,
web searches, plans, and future non-message App Server items must not be
serialized into assistant markdown. The adapter must append one started activity
when an item starts and one completed activity when it settles. Unsettled calls
are closed as failures when the stream terminates. Completed command
activities carry bounded output in their event payload so the UI can show it in
an expandable shell/detail panel without changing the assistant message body.
Command activity labels distinguish running from completed work, prefer Codex's
structured command actions (read/search/list), and retain the full command only
in expandable details. Consecutive activities are grouped in presentation; naming
each individual call `Ran commands` is not grouping. See
[Execution presentation acceptance](execution-presentation.md).

When App Server exposes duplicate command output through both legacy
`codeModeShell/outputDelta` and modern `commandExecution/outputDelta`
notifications, the adapter keeps a single reconciled activity output. Late
output deltas after item completion are ignored.

Unknown App Server item types that are not user, assistant, or reasoning items
must also become activity rows. This fail-open-for-presentation rule prevents new
Codex tool surfaces from falling back into MarkdownText while preserving DSH as
the owner of conversation layout.

## Verification contract

1. A unit contract test fails when either required Host injection is absent.
2. A Cordis composition test mounts interaction services as sibling providers,
   mounts the Codex consumer with its exported `inject`, and completes one
   approval plus one question request.
3. Handler and runtime tests cover allow, deny, permission, answer, stale
   ownership, unknown Session, and unsupported request mappings.
4. An official DSH Web acceptance test uses two independent Codex Sessions.
   Both request the same class of outside-Workspace write. Before either answer,
   both target files are absent and the sentinel is unchanged. One-time allow
   creates only the allow target with exact bytes. Reject leaves the deny target
   absent. Both Sessions finish normally and remain usable.
5. The historical pre-fix plugin commit must reproduce the missing approval UI
   and automatic fail-closed response for the same request shape.
6. Subagent tests emit App Server-shaped `subAgentActivity` notifications while the
   root Turn remains live, cover direct and nested descendants plus duplicate,
   conflicting, unbound, orphaned, cyclic, stale, expired, and cross-Session trees,
   and assert rejected trees execute zero DSH tools. An official DSH Web regression
   proves one child reads the exact oracle through the DSH tool bridge and returns it
   to the owning parent without a parent-side read.
7. Codex adapter tests prove command output, mixed file/image/MCP/search items,
   duplicate legacy/native command streams, empty outputs, and late deltas are
   emitted as bounded native tool events and never as assistant text deltas.
8. Codex client tests prove the plugin registers the activity conversation
   definition for legacy reads, injects the native keyed tool view, and renders collapsed
   activity rows plus expandable shell/details without markdown interpretation.
9. Real official JSONL persistence tests cover both plaintext and zstd: stream a
   tool through the adapter, persist it, dispose the writer, load using a fresh
   reader, and reopen twice. Assert exact event preservation, known event types,
   call/result pairing, coordinates, output, and final assistant text.
10. Legacy repair tests reproduce `SessionFormatUnsupportedError` before repair,
    verify exact backup bytes, then cold-load through official persistence.
    Verify dry-run, idempotence, malformed/torn refusal, and unchanged unrelated
    unknown events. Component tests cover native running-to-settled updates,
    result-only history pages, interruption, and malformed payload fallback.
11. Root scan tests include an old-dated log, multiple workspaces, both physical
    encodings, an already repaired log, backups, symlinks, and corrupt input.
    No date or workspace selection may omit an affected canonical log.
