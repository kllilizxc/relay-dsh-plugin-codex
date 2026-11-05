# Worka public compatibility release 0.2.5-rc.1-worka-public.4

This release advances the immutable `0.2.5-rc.1-worka-public.3` compatibility source. It preserves the existing DSH 0.2.1-rc.2 and React 19.3.0 peer contract, Codex CLI 0.166.0 and the same publicly bundled session-import package.

## Change

Codex model catalog refresh failures no longer suppress the model choices already verified on App Server startup. An initially empty/invalid model list still fails visibly. The host does not invent models or override user authentication.

## Verification and release

The dedicated tagged-source release workflow runs the existing DSH-integrated `npm run verify`, requires generated `lib/` to match committed source, and packs through npm with the same exact public session-import dependency. The workflow publishes an immutable digest-named archive, its SHA-256 checksum, its SHA-512 npm integrity and a source-commit provenance record. Worka must update its manifest and frozen lock to the new verified asset; merely updating this source branch is not a deployment.

The previous `0.2.5-rc.1-worka-public.3` archive remains unchanged. Do not publish over an existing tag or modify a verified release asset.
