# DSH 0.2.1-rc.2 compatibility candidate

This local `0.2.5-rc.1-fork.2` candidate targets DSH `0.2.1-rc.2` and React 19.
The LLM, Session and Typert peers are pinned to this tested DSH release. No
compatibility claim is made for older DSH generations by this candidate.

The current tool-result message owns `role: tool`, `toolCallId`, raw content and
`isError`. Live activity and history import now write this format, retaining
stable imported message and call identities. Read-side projection still accepts
the earlier embedded tool-result envelope.

The client uses configForms, the Plugins tab slot, mainView reference counts
and uiWorkspace navigation. Settings refusals retain the draft; disposal removes
the card subscription. Images use the official root gallery factory and its
authorized loader. Tool calls without parsed arguments render safely.

The current native assistant owns child slots and presentation hooks. Its
renderer and child-slot declarations remain intact. The optional Codex process
replacement yields the entire takeover to native presentation in that case,
leaving native tool rows, images, reasoning and final answers visible. Legacy
leaf renderers can still use the existing replacement. This avoids both duplicate
answers and duplicate child-slot ownership.

## Verification

Use the prepared official DSH source commit
`d1b9c0406783051f53587719372489aa0a9d76ac` via `DSH_ROOT`; the development linker
accepts this release and uses its canonical host libraries. The `prepare:dsh`
script invokes Node directly so Windows checkout CRLF does not break Bash.

- Typecheck and host/client build pass.
- Eight focused Node test files pass 125 cases: live activity, cancellation,
  native tool results, official JSONL none/zstd cold load, stable and idempotent
  history import, host services, session navigation and workspace import.
- Six focused component/projection files pass 137 cases on React 19, including
  current tool-role results, unchanged native child-slot ownership, refused
  settings drafts and subscription disposal.

No personal profile, real model/backend request, real browser or Electron
acceptance was run. This is a local source/build candidate, not a published release.

## Remaining dependency boundary

The user deferred Claude and session-import migration. The existing
`relay-dsh-plugin-session-import@0.2.3` dependency still declares React 18. It
prevents a strict React 19 npm dependency graph, including the Desktop lock.
The npm lock remains the prior baseline; the local Bun development resolution
is recorded separately. Do not claim `npm ci` or full Desktop installation passed,
and do not bypass peer checks to publish this candidate as a compatible runtime.
