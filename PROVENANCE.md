# Source and build provenance

This release builds on the public compatibility source commit `351d4d38edd5fa1b5cede85eb39526dbbc6f094c` and includes the user-message whitespace fix from `39aac48f3775a30595d28ab21e1c22681bbc6d8b`. It targets DSH 0.2.1-rc.2 and React 19.3.0, bundles the fixed public session-import release, and uses the current DSH session refresh interface. The upstream MIT license is retained. The bundled lucide-react license is included in `licenses/lucide-react.txt`.

Build with Node 24.14.1 and npm 11.11.0, the committed npm lock, and public DSH 0.2.1-rc.2 checkout `687f282e8625c6b8d11ff58211a90524be2e4317`. Prepare the DSH checkout with pnpm 11.28.5, `pnpm install --ignore-scripts --frozen-lockfile`, `pnpm run build:native-system` and `pnpm run build:lib`. Run `npm ci --ignore-scripts --strict-peer-deps`, then `DSH_ROOT=<official-checkout> npm run build` and `npm pack --ignore-scripts`. The release tarball is a normal npm pack of this tree and omits source maps.
