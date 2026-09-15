# @moor/app-desktop

Electron entry, main-process lifecycle, finite preload APIs and local settings.

From the repository root, run `pnpm dev:desktop`. The pinned electron-vite toolchain
builds main/preload once and serves the shared React renderer with Vite and Fast
Refresh. It watches source imports, including shared workspace packages; editing
the UI does not build the CLI/relay or restart the execution host.

| Changed code                                        | Development behavior                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| CSS / refresh-compatible React components           | HMR / Fast Refresh; no Electron or host restart                      |
| Renderer bootstrap or incompatible refresh boundary | Renderer reload; main and host remain alive                          |
| Preload                                             | Rebuild standalone sandbox-compatible preload files; renderer reload |
| Main / settings assets / main-side typed clients    | Rebuild and restart Electron                                         |
| Host / CLI / security runtime dependencies          | Incremental runtime rebuild; successful revision restarts the host   |
| Relay-only code                                     | No desktop rebuild                                                   |

Shared sources rebuild each target that imports them; changing a shared protocol
can therefore update both the renderer and the host-side runtime.

Host changes can interrupt an active development turn. They never replay a
request or send a saved draft. Failed builds keep the last successful output.
React refresh is not guaranteed to preserve state across every module change;
the controller continues to own durable drafts and operation identities.

Run `pnpm build:desktop` for a complete desktop build in `dist/desktop`, followed
by `pnpm preview:desktop` to verify the production loading path. `pnpm build` also
builds the web, host, CLI and relay products. Packaging/signing stays separate.

After `pnpm build:desktop`, run `pnpm check:desktop:electron` for a real Electron
check of React/CSS HMR, preserved component state, finite IPC, the production
protocol and offline WASM. It also runs the actual launcher with an empty isolated
host to check host-only reload, main restart and shutdown. It uses temporary
profiles and synthetic data, never a real account, project or Agent. It needs a
graphical Electron environment; stop any existing desktop watcher first.

Development alone permits the launcher-owned Vite origin, bound to `127.0.0.1`
(port 5173 by default, configurable with `MOOR_DESKTOP_DEV_PORT`). Startup checks
the per-run server identity; occupied ports fail instead of silently selecting a
different service. Resource requests and HMR are limited to that origin, and Vite
cannot serve the development data directories. Main still checks the registered
window, current main frame and finite IPC schemas. Sandbox, context isolation and
the main-owned business transports remain enabled.

Production builds compile out the development opt-in and still use immutable
`moor-client://` resources. Setting development environment variables cannot
switch a production build to a dev server. Run the packaged-path checks before
release; a development URL is not a substitute for that validation.

Development state is kept separately in the ignored
`.runtime/desktop/data` directory. Set `MOOR_DESKTOP_DATA_DIR` explicitly only
when another development data directory is required. Stop the watcher and its
Electron process with Ctrl+C. The renderer has no generic filesystem, shell or
socket API in either mode. The development server must never be exposed to a LAN.

The renderer comes from `@moor/app-web`; typed workspace and encrypted clients come
from `@moor/client` and `@moor/e2ee`. No generic shell or socket proxy is exposed.
