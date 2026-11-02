# Worka public compatibility release 0.2.5-rc.1-worka-public.3

This release combines the previous compatibility release `3c17ed04a2e19f1793750f6712b5b254b2c237bb` with merged Relay PR #2 at `e170713089b6aa4355d4a46f77b8e5bd08a523f1`. It targets DSH `0.2.1-rc.2` and React `19.3.0`. The Codex host bundle matches the merged main commit. The client bundle, session-import integration and bundled licenses match the previous compatibility release. The launcher and six platform-specific aliases in the committed npm lock use Codex `0.166.0`. Worka Desktop downloads its managed platform binary separately.

## Reproduce the release archive

Use Node 24.22.1 and npm 11.9.0 in a fresh checkout of the tagged source. The reviewed generated bundles are tracked. Fetch the session-import archive from its public release, verify it and unpack its content into the dependency directory before packing. These commands require no access to any Worka profile.

```sh
set -eu
session_digest=19d23534cffb0eb6f3e0b5f7580cdbf0d846dc79337383f080e52c8d01b96fa4
curl --fail --location --output session-import.tgz "https://github.com/kllilizxc/relay-dsh-plugin-session-import/releases/download/v0.2.4-rc.1-worka-public.2/${session_digest}.tgz"
printf '%s  %s\n' "$session_digest" session-import.tgz | sha256sum --check
mkdir -p node_modules/relay-dsh-plugin-session-import dist-release
tar -xzf session-import.tgz -C node_modules/relay-dsh-plugin-session-import --strip-components=1
npm pack --ignore-scripts --offline --pack-destination dist-release .
sha256sum dist-release/*.tgz
```

The resulting package contains 38 entries, including the bundled session-import package. The archive is 331581 bytes. Its SHA-256 is `6cedc240ce1e03abbba97cb31b12dd715a3ee4bcba7be13be066264634e9daab`, and its npm integrity is `sha512-NeRH/VmNZWejUjChE+Q1u/Y5daI/8zAtZ37W2nYZAkZ/xJukEnr4gjrGnTWYf+gqxOBw4Qr8tT2YasMnBl7j+A==`.
