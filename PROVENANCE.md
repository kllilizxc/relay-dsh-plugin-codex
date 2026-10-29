# Source and build provenance

This version builds on the existing public repository commit `e0aa8be0c9d75acb5a57ba516ccc1dce155d5a36`, targets DSH 0.2.1-rc.2 and React 19.3.0, bundles the fixed public session-import release, and uses the current DSH session refresh interface. The upstream MIT license is retained. The bundled lucide-react license is included in `licenses/lucide-react.txt`.

Build with Node 24.14.1 and npm 11.11.0, the committed npm lock, and prepared public DSH 0.2.1-rc.2 checkout `687f282e8625c6b8d11ff58211a90524be2e4317`. Run `npm ci --ignore-scripts --strict-peer-deps`, then `DSH_ROOT=<official-checkout> npm run build` and `npm pack --ignore-scripts`. The release tarball is a normal npm pack of this tree and omits source maps.
