# Codex Execution Presentation

## Scope and baseline

Plugin-only integration against immutable official DSH
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. DSH continues to own navigation,
composer, history, attachments, and execution controls. No official source edits,
new mandatory persistence event types, PR, or private session logs in this repo.

The supplied 2026-08-30 recording is the behavioral reference: readable progress
paragraphs interleave with grouped tool activity; only the current activity is
foregrounded while tools run; the process can collapse when the answer is ready.
The current one-row-per-command implementation is not accepted as grouping.

## Delivery slices and review gates

1. Projection: reconstruct an ordered, turn-scoped presentation from native
   chunks and native tool envelopes. Tool messages must not finalize or erase
   streamed commentary. Keep text, reasoning, images, and tool data distinct.
   Review ordering, incremental versus full replay, duplicates, and ownership.
2. UI: group adjacent tool activities between text/image boundaries; expose one
   summary/current action by default and all individual details on expansion.
   Use stable keys, semantic labels, truthful status, bounded shell panels,
   accessible disclosure controls, and existing DSH design primitives.
   Review long labels, interrupted/error work, images, and foreign-provider views.
3. Integration: build/typecheck/full tests plus official persistence round trips,
   restart and history reload. Review loader compatibility and source cleanliness.
4. Live acceptance: submit exactly `当前Relay项目还有哪些逻辑没有实现为DSH插件？`
   in the Relay workspace using `gpt-5.6-sol` with `high` reasoning. Capture live,
   expanded-detail, final-answer, and reopened-history screenshots. Record model
   and actual outcome; do not substitute a synthetic preview for live evidence.

Each slice needs its own test results and review before delivery. Synthetic tests
cover nondeterministic branches; the real question is the final acceptance, not
a speed comparison with an independent Codex App run.

## Acceptance scenarios

| ID | Scenario | Required observation |
| --- | --- | --- |
| EXEC-01 | Commentary, ten tools, commentary, more tools, answer | Commentary appears while running, in source order; two compact tool groups, not ten top-level rows |
| EXEC-02 | Streaming commentary followed by native tool request | Tool-only assistant message cannot erase or freeze commentary |
| EXEC-03 | Read/search/list, shell, edit, image and unknown tools | Semantic current label and category icon; unknown tool remains inspectable |
| EXEC-04 | Open a group and child while new items arrive | Stable disclosure state; command/output retains newlines and is never Markdown |
| EXEC-05 | Concurrent tools, nonzero exit, cancellation | Active count is truthful; error is not green success; unresolved calls settle on termination |
| EXEC-06 | Final text-only answer and answer after tools | Answer remains visible; process collapses without losing history; reopenable process |
| EXEC-07 | Images and consecutive file edits | Images use DSH attachment rendering; edits remain expandable and ordered |
| EXEC-08 | Refresh/reopen/cold-load plaintext and multi-frame zstd | Same logical order and grouping, no duplicate text or unsupported event error |
| EXEC-09 | Non-Codex session and mixed-provider history | Native rendering and controls unaffected; ownership is turn-scoped |
| EXEC-10 | Desktop/narrow viewport, long path, keyboard disclosure | No horizontal overflow/overlap; Enter/Space disclosure works; status is not color-only |
| EXEC-11 | Exact user question, Sol High | Real execution visibly meets live grouping and commentary criteria; retained screenshots |
| EXEC-12 | Cancel after a command emitted partial output | Failed terminal result retains all buffered output within the existing output limit |
| EXEC-13 | Imported native tools or foreign-provider steps between Codex paragraphs | Preserve native chronological rendering where a complete grouped projection is unavailable |
| EXEC-14 | Generated image before final prose, or image-only completion | Deliverable remains visible after process collapse; viewing an image remains tool activity |
| EXEC-15 | Closing answer references a known produced file | Preserve the native closing-turn resolver; completed structured Codex edits also resolve through the native DSH opener |
| EXEC-16 | Replacement mount fails or plugin unloads | Native assistant and tool content remains available or is restored; no invisible conversation |
| EXEC-17 | Pack and clean-install in isolated official DSH profile | Install the actual tarball, not a workspace link; execute its browser loader without missing modules; verify installed bundle identity |
| EXEC-18 | Upgrade published 0.1.4 to candidate, restart | Existing native history stays readable, new grouped history reloads; installed client is the candidate, not stale same-version package content |
| EXEC-19 | Native DSH, Codex-only, Claude-only and combined profiles | All selected loaders execute; native and Claude histories do not receive Codex process ownership |
| EXEC-20 | Keyboard and real 390 x 844 viewport | Enter and Space toggle process/group/child disclosures; focus remains visible; no horizontal document overflow |
| EXEC-21 | Real edit, image-view and produced-file workflow | Actual file content changes; edit and image categories render; final file reference opens via native DSH; viewed image bytes decode |
| EXEC-22 | Browser failure/cancel, cold replay and image delivery | Explicit terminal states and retained partial output; no duplicate activities after reload; generated image output remains visible after collapse |

Delivery evidence distinguishes real model execution, deterministic protocol
fixtures, component tests, and manual-only checks. Fixture image delivery is not
reported as a successful live image-generation service call. Tarballs, raw logs,
isolated profiles and screenshots stay outside the repository. No publishing or
PR creation is part of these acceptance commands.

## Output and file contracts

Cancellation preserves stdout already received by the adapter, including
notifications queued while the interrupt RPC is pending. Only commands already
owned by that turn may be settled; foreign turns, unknown commands and new prose
are not admitted during cleanup. An immediate stop before the execution backend
delivers stdout may legitimately have no output. The acceptance oracle examines
persisted activity output, not text echoed in the command input.

The pinned Codex runtime cannot enable first-yield raw notifications for a
Thread created without them by an older plugin. Upgrade acceptance must preserve
that Thread and its history, not silently replace it. First-yield cancellation
acceptance uses a new post-upgrade Session; an old Thread can retain only output
the backend actually delivers. See the compatibility contract in
[Reliability](../reliability-spec.md#command-output-streaming).

Synthetic Codex file activities do not have native DSH mutation presenters.
Supplement the native file-mention resolver only with completed structured
file-change records. Exact paths and unique basenames can open through DSH;
ambiguous, failed, running, deleted, malformed and prose-only paths cannot.
Renames replace the old path with the destination. Native resolution retains
priority and is returned unchanged when there are no produced Codex files.

Reasoning is secondary and collapsed, not mixed into assistant prose. Missing
model commentary must not be invented. Partial history must fall back without
discarding available content. Debug context remains available without dominating
normal Codex process presentation. Model phase information may be used only when
actually supplied; do not guess a final answer from its wording.

Older text-only projections without presentation metadata remain native. A
visible legacy activity between projected segments also disables takeover; its
native row must not be crossed by moving later prose to the process anchor.
Missing tool-call history, unrepresented tool types, and mixed providers likewise
retain native presentation until the projection has sufficient evidence.

## Optional host tool presentation

A host may provide the optional client service `conversationToolPresentation` with
`subscribe(listener)` and `hideToolRows(sessionId)`. When it returns true for a
session, the grouped Codex process omits duplicate `dsh / workbench` activity
rows while preserving streamed prose, other activities, and the native tool
records and their accessory slots. The service can appear or disappear at
runtime. Without it, or for sessions it does not select, existing presentation
is unchanged. This policy is visual only and does not change tool authority,
execution, stream delivery or persistence.

The same optional service may supply
`projectAssistantText(sessionId, turn, text)` to disclose only user-facing
assistant text. The grouped process applies it in its shared projection before
publishing both turn Location data and chat View nodes, so answer selection,
copying and rendering consume the same disclosed text. The projection receives
cumulative text across provider items, including live prefixes; it does not
rewrite raw reducer state, events, persisted history or model input. The host
owns any private-text syntax and per-turn authorization. Session identity comes
from the owning assembler, never the currently selected conversation; an
unknown owner is passed to the host explicitly. A host that supplies this
policy must invalidate its display projections when its scope becomes known.
Without the optional projector, literal assistant text remains unchanged.

The grouped renderer is an independent assistant-text path: `ProcessItems` in
`CodexProcessView.tsx` sends each published text segment to `MarkdownText`.
Filtering only native `assistant-step` rows cannot protect that renderer.
`test/notebook-grouped-renderer.spec.tsx` exercises the installed presentation
slot through its real process component and Markdown boundary, including every
live prefix of both private block forms, a tag divided between provider items,
settled history, and unchanged ordinary text. Its no-projector control reproduces
the raw-segment disclosure in older clients.
