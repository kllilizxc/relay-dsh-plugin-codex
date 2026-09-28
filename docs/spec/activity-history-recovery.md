# Activity History Recovery Acceptance

Validated 2026-08-30 against official DSH
`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. No official source changes or PR.

## Root Cause

The previous activity tests used a fake Session and reconstructed only assistant
text with `Session.fromRestore`. They did not cold-load emitted activity events
through the official persistence coordinator. Client declaration merging did
not register `relay-codex/activity` in the coordinator's known-event vocabulary.
The resulting log rendered live but failed after reopen. The public append API
also discards unsupported envelope options, so adding an `ignorable` argument
there would not fix the writer.

## Delivery Gates And Review

| Part | Acceptance scenario | Review result |
| --- | --- | --- |
| Writer | Tool output stays out of assistant text; native request/call/result envelopes preserve current Turn/Step and identity | Adapter assertions and real Session tests pass; no custom event writes remain |
| Cold load | Persist to plaintext and multi-frame zstd, dispose writer, load with a fresh official reader, reopen twice | Exact event equality and complete tool outputs pass in both formats |
| Termination | Stop with pending native activity, including failed backend cleanup | Activity settles as failed; subscription is released; unconfirmed cleanup is not reported as success |
| Client | Running row settles without losing expansion; result-only page renders from meta; interruption and malformed payloads do not crash | Native keyed toolview and legacy chat node coexist; component tests pass |
| Repair | Old log refuses before repair and loads after repair | Only validated legacy activity envelopes gain `ignorable: true`; seq/time/data remain identical |
| Repair safety | Dry-run, exact backup, repeat invocation, torn/malformed data, unrelated unknown type | Dry-run and repeat are no-ops; damaged input is refused; unrelated types remain required |
| Package | Consumer receives built client/host plus repair entry and its dependency | Typecheck, build, and package dry-run pass |
| Existing session | Reopen the locally reported failing conversation and expand a stored command | Official reader loads all 260 events including 30 activities; browser shows no history error and expands Shell output |
| New live session | Execute only `printf HISTORY_RELOAD_OK`, refresh the browser, cold-load with a fresh official reader | All 42 events use known types; one paired native result preserves the exact marker; refreshed `Ran commands` row still expands |

`npm run verify`: 205 unit tests and 7 component tests passed, followed by build.
The affected private log has a byte-for-byte backup beside the original. Neither
that backup nor customer/session content is committed as a fixture.

## Operational Recovery

The first local recovery only repaired one reported Session and audited recent
logs in one workspace. That scope missed earlier logs and other workspaces.
The recovery utility now audits the entire configured root, without timestamps
as a selection criterion, and reports incomplete scans instead of claiming success.

The subsequent full-root acceptance scanned 41 canonical logs across workspaces,
found 10 additional affected Sessions (257 activity events), verified every
byte-for-byte backup and exact preservation of all non-marker fields, and
cold-loaded all 10 using official persistence. The newly reported Session
retains all 282 events. Final rescan: 41 logs, zero affected, zero errors.
Browser acceptance clicked that exact existing Session in the sidebar and
reloaded it; the original question and conversation remain visible and the
history error count is zero. DSH stays available on the original local port.

Stop DSH processes using this session root before applying repair. Preview and
repair the full root, then require a zero-affected, zero-error rescan:

```sh
node scripts/repair-activity-history.mjs --root /path/to/sessions
node scripts/repair-activity-history.mjs --write --root /path/to/sessions
```

For a specifically scoped diagnostic, single-file preview and repair remain available:

```sh
node scripts/repair-activity-history.mjs /path/to/session.jsonl.zstd
node scripts/repair-activity-history.mjs --write /path/to/session.jsonl.zstd
```

The script reports the backup path. Restart DSH with the rebuilt plugin, reopen
the same conversation, and verify its activity details. The legacy presentation
payload is not rewritten; older rows retain their saved title. New activity
rows use the current plugin presentation.
