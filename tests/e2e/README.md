# End-to-end tests

Run `pnpm test:e2e` from the repository root. It builds workspace packages, Host/CLI and Web before running these scenarios serially. Node.js 24+ and the locked Electron binary are required; Linux needs a display or `xvfb-run --auto-servernum pnpm test:e2e`.

| Scenario                   | Real boundaries                                                                                     | Synthetic boundary                            |
| -------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `cli-host.test.ts` — local | Built CLI, private connection proof, HTTP, Host subprocess, SQLite, ACP stdio subprocess, restart   | Agent output and temporary project            |
| `cli-host.test.ts` — relay | Built CLI/Host, production Relay app, HTTP/WebSocket, pairing, account/Host databases, ACP, restart | Account credentials, Agent output and project |
| `browser-workspace.cjs`    | Built Web, Chromium, IndexedDB, reload and authentication state                                     | HTTP API (no Host)                            |
| `workspace-layout.cjs`     | Current React/CSS in Chromium, desktop/narrow layout, theme and selection                           | In-memory workspace controller (no Host)      |

`renderer.test.ts` launches the two Chromium scenarios, propagates failures and removes their temporary profiles/screenshots. No scenario uses real Agent accounts, user data or fixed sleeps. Readiness comes from Host messages, DOM changes or database transaction completion; deadlines only fail hung runs.

The CLI journeys verify empty creation, one accepted send, duplicate retry without another turn, follow/stop, metadata changes, retained history and receipts after restart, logout and login. Browser scenarios verify unsent draft persistence, grouping protection, offline read-only restoration, authentication failure and native Agent commands appended to the draft without automatic submission. They do not yet prove a browser-to-Host send/approval journey.

`pnpm test` includes all scenarios before integration tests. To rerun already-built artifacts: `node scripts/validation/test.mjs --e2e`. For packaged CLI/Host validation, use `MOOR_TEST_PACKAGED_APP=/absolute/path/Moor.app pnpm exec tsx --test tests/e2e/cli-host.test.ts`.

Precise approval races, dropped receipts, attachments, Git/Fork and durable queues retain targeted integration coverage. Real accounts, dual Mac, Safari/PWA, system notifications, sleep/wake, Developer ID and notarization require [device validation](../../docs/validation.md); synthetic results never imply they passed.
