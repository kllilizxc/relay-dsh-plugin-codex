# Execution Presentation Review

Date: 2026-08-30. Official DSH reference:
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (unchanged).

## Delivery reviews

| Slice | Review findings and disposition | Evidence |
| --- | --- | --- |
| Projection | Preserve block chronology across tool-only checkpoints; keep explicit model phases; reject unsupported, foreign, orphan-result, and ambiguous legacy takeover | Pure reducer and actual official conversation assembler regressions |
| Activity and UI | Stable grouped disclosures; semantic command metadata; bounded literal output; keep generated images visible and ordered; retain native closing-file resolver | Component tests and native SlotCore composition tests |
| Failure and lifecycle | Preserve buffered command output on cancellation; restore native content after replacement failure/unmount; do not hide unrelated context | Adapter cancellation matrix and mounted/error-boundary tests |
| Integration | Native persistence envelopes only; current and legacy replay provenance supported; no official DSH changes | Unit tests, typecheck, build, package dry-run, real history reload |

Independent reviews identified four defects: cancellation output loss, native
history ordering, generated-image visibility, and final file-opening controls.
Each received a focused fix and regression coverage. The final projection review
also covered result-only pagination and legacy history fallback.

Final `npm run verify`: 232 unit tests and 121 component tests passed, including
61 projection cases. TypeScript and both bundles passed. `git diff --check` and
`npm pack --dry-run` passed; no PR was created.

## Follow-up delivery reviews

| Slice | Additional finding and disposition | Final evidence |
| --- | --- | --- |
| Produced files | Native file-mention wiring alone was insufficient for synthetic Codex edits. Added completed structured-change resolution, preserving native priority and rejecting ambiguity, invalid data and obsolete rename paths | Six focused resolver tests; actual DSH file-open response with `opened: true` |
| Interrupt lifecycle | Notifications received while awaiting interruption could be discarded. Drain only already-owned commands for the active turn before cleanup | Three late-output cases covering native, raw and completion snapshots; real new-Session stop retains persisted stdout |
| Installation | Serving a client asset was weaker than executing its module loader | Nine actual-tarball installation combinations pass browser loader checks |
| Isolation | Codex presentation must not affect native or Claude histories | Real Claude Sonnet and Codex Sol High, plus native DSH adapter with deterministic HTTP/SSE provider; switch/reload passes with no browser errors |
| Acceptance oracles | Command-input text could falsely satisfy stdout checks; zero overflow could hide a squeezed mobile column | Assert persisted output separately; test native collapsed-sidebar reading layout, minimum readable width and image bounds, then inspect screenshots |
| Image generation | A live image-view case did not cover generated-image completion | Valid-byte deterministic generated-image ordering/deduplication regression, separately identified from real image viewing |

Root regression: 450 tests passed, no failures or skips. The final delivery
runner (`relay-codex-delivery-6gHd5K`) passed all eight checks, including published
0.1.4 upgrade, real Sol High file editing/image viewing/exit 7, file opening,
keyboard, 390 x 844 viewport, new-Session cancellation and cold history replay.
Coexistence run `relay-codex-coexistence-wvKr7s` passed all three checks. Desktop,
expanded failure, cancellation stdout and narrow screenshots were reviewed.
No known blocking finding remains within the documented compatibility scope.

## Real acceptance

Submitted the exact question from EXEC-11 in a fresh Relay workspace session,
using the Codex preset and `gpt-5.6-sol` / `high`. The model selector and persisted
final source identify the requested model; the run completed normally in 151
seconds. This was real model execution, not fixture replay.

- Three distinct commentary messages remained in source order.
- Twelve command activities appeared as two groups of three and nine.
- Expanding a group and its command retained disclosure state as more activities
  arrived. Shell output kept literal newlines.
- All twelve represented native tool rows were suppressed, with zero visible
  duplicates; generic system-prompt context did not dominate the process.
- Completion automatically collapsed the process and kept the answer visible.
- Refresh restored the same answer, three commentary messages, and two groups;
  expanding and collapsing remained functional, with no history-load error.
- A full DSH host restart and latest-client reload produced the same completed
  process, 2127-character rendered answer, and 3/9 tool groups without duplicates.
  The previously failing legacy model/tool question also cold-loaded successfully
  with its three original activity rows and native assistant presentation.
- Desktop capture was 1280 x 720. A real 472px conversation column, obtained by
  opening the native side panel, had no horizontal document overflow. This is
  narrow-column coverage, not a separate mobile-device run.

Screenshots are retained outside the repository to avoid committing local
session content. The delivery includes live, expanded-command, completed,
reloaded-history, and narrow-column captures.

## Boundaries

This reproduces the grouped execution interaction, not every Codex App pixel or
every native app integration. Histories missing sufficient structured data use
native DSH rendering instead of speculative grouping. No model commentary is
fabricated and no raw session logs are committed.

Controls use native buttons, focus styling, and `aria-expanded`. Click behavior
and accessibility state are covered by component and live tests. The earlier
background in-app-browser keyboard limitation was resolved in acceptance by
using a separate headless browser: actual Enter/Space now pass at process, group
and child levels. A real 390 x 844 browser viewport passes with the native sidebar
collapsed; a physical phone and screen-reader session were not run.

The pinned Codex runtime cannot enable first-yield raw output for an old Thread
created without that subscription. The upgrade case preserves its original
Thread and history; the first-yield cancellation case explicitly uses a newly
created candidate Session. This limitation is not hidden by recreating old
Threads or by treating command input as stdout. Generated-image delivery uses
a deterministic protocol fixture, not a live image-generation service call.

No commit, push, tag, PR or registry release was performed. Version 0.1.4 remains
the development package version; release versioning is a separate authorized step.
