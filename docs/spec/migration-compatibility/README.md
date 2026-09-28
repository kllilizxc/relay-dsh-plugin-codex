# Codex Migration Compatibility Specification

## Purpose

This specification defines the independently verifiable capabilities required for
an existing Codex user to move project work into the DSH Codex plugin without
falling back to text-only chat.

The unit of verification is one atomic Codex capability. End-to-end project tasks
are downstream coverage checks, not substitutes for atomic evidence.

## Independence boundary

- All requirement IDs use the `CDX-` prefix.
- Codex cases, fixtures, scripts, run records, reports, and evidence live under
  `validation/migration-compatibility/` in this plugin repository.
- No Claude result can satisfy a Codex requirement.
- A shared DSH behavior must still be verified through the Codex App Server path.
- Existing reliability specifications remain authoritative for App Server lifecycle
  and binding behavior; this specification covers migration capability parity.

## Specification files

- [requirements.md](requirements.md) is the atomic capability catalog.
- [verification-methods.md](verification-methods.md) defines acceptable verification
  methods, result states, and evidence.
- [acceptance.md](acceptance.md) defines completion and release gates.

## Traceability contract

Every requirement must trace through the following chain:

```text
CDX requirement -> Codex case -> immutable run -> result -> evidence
```

The corresponding paths are:

```text
docs/spec/migration-compatibility/requirements.md
validation/migration-compatibility/cases/<requirement-id>--<slug>.md
validation/migration-compatibility/runs/<run-id>/run.md
validation/migration-compatibility/runs/<run-id>/results.md
validation/migration-compatibility/runs/<run-id>/evidence/
```

Run records are append-only. A rerun creates a new run directory and never rewrites
historical evidence.

## Requirement lifecycle

`draft -> ready -> verified | failed | blocked -> retired`

- `draft`: scope or observable result is incomplete.
- `ready`: a case and required fixture exist.
- `verified`: the latest applicable run passed with sufficient evidence.
- `failed`: the plugin behavior did not meet the expected result.
- `blocked`: the method could not execute; this is not a pass.
- `retired`: the capability is no longer part of the supported migration contract.

