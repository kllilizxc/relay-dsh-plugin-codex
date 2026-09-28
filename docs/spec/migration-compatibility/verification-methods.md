# Codex Verification Methods

## Verification levels

| Level | Name | Purpose | Model/account required |
| --- | --- | --- | --- |
| `S` | Static | Package, source, configuration, and boundary inspection | No |
| `P` | Protocol | Fake App Server request/notification and adapter conversion | No |
| `A` | Automated integration | Real DSH contracts with deterministic fake backend or fixture tool | No |
| `L` | Live Codex | Signed-in real Codex App Server capability check | Yes |
| `W` | DSH Web E2E | Visible official DSH behavior and persisted presentation | Yes |

Use the lowest level that proves the requirement. A protocol pass does not satisfy a
requirement whose minimum observable is user-visible or depends on real Codex-owned
configuration. Such a requirement must also have `L` or `W` evidence.

## Case contract

Every case records:

- one primary `CDX-*` requirement ID;
- exact preconditions and isolated fixture;
- exact command, API operation, or DSH interaction;
- expected protocol, filesystem, transcript, and presentation observables;
- cleanup steps;
- required evidence and redaction rules;
- automation level and whether a real account is required.

One case may provide secondary coverage for other requirements, but it cannot replace
their own primary cases.

## Result states

- `pass`: every expected observable is present and no forbidden observable occurred.
- `fail`: the plugin executed but at least one expectation was violated.
- `blocked`: execution could not reach the behavior because of environment, account,
  service, or test-infrastructure failure.
- `not-run`: the case was not attempted in this run.
- `not-applicable`: allowed only when the requirement specification explicitly permits it.

## Required run metadata

- date and timezone;
- plugin version and Git commit;
- dirty/clean repository state;
- Codex package/App Server version;
- DSH version and commit;
- Node.js version, OS, architecture, and browser when applicable;
- isolated fixture revision or digest;
- exact commands and configuration layers;
- start/end time and operator or automation identity.

## Evidence rules

- Keep sanitized transcripts, protocol excerpts, filesystem diffs, screenshots, and
  logs under the immutable run directory.
- Record hashes for binary fixtures and output artifacts.
- Never store credentials, real customer content, home-directory configuration, or
  private production logs.
- A screenshot alone cannot prove protocol identity, filesystem mutation, or config
  precedence; preserve the matching machine-readable evidence.
- A blocked run remains blocked even if an earlier run passed.

