# Tests

`pnpm test` runs end-to-end journeys first, then integration and workspace tests.

- `e2e/`: built CLI/Host journeys over local HTTP and Relay HTTP/WebSocket, plus real Chromium recovery and layout checks. Run `pnpm test:e2e`.
- `integration/`: cross-package contracts and deterministic fault injection that complement the journeys. Run `pnpm test:integration` to diagnose these separately.
- `fixtures/`: synthetic Agents, service adapters and UI fixtures. They never read real accounts or user projects.

Workspace tests live beside their owning package or app. Add a unit test only when a focused boundary needs coverage that the user journeys cannot reliably provide. Keep compatibility tests for persisted records that production still reads; remove tests and fixtures for deleted execution paths.

Keep one primary test for each user journey. Lower-level tests must cover an additional failure, security boundary or persistence invariant, rather than repeat the same happy path with mocks.

| Coverage                                       | Primary evidence                                                                                                             | Necessary focused regressions                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Create, send, stop, organize, restart          | [Built CLI/Host E2E](e2e/cli-host.test.ts)                                                                                   | Receipt loss, exact approvals, authorization changes and transaction rollback |
| Drafts, navigation, appearance, Agent commands | [Chromium scenarios](e2e/README.md)                                                                                          | Cross-page storage races, identity changes and unsafe content                 |
| Attachments, Git/Fork, Skills, questions       | [Workspace controller and Host](integration/workspace-controller.test.ts)                                                    | Corrupt bytes, filesystem boundaries, stale reviews and late responses        |
| Persisted compatibility data                   | [Browser migration](integration/browser-workspace.test.ts), [retired features](integration/retired-session-features.test.ts) | Read-only preservation and rejection of new execution                         |

Before retaining a helper test, check that the helper is called by current application code. Tests must not keep a retired controller or renderer alive. Move any still-relevant assertion into the current journey, then delete the obsolete test, fixture and unused implementation. Browser command behavior belongs in the real Chromium scenario; ACP startup, permission and recovery belong in the [Host conversation](integration/runtime.test.ts), with subprocess ownership in [local Host tests](integration/local-cli-host.test.ts).

On Linux without a desktop, use `xvfb-run --auto-servernum pnpm test`. Electron is required; graphical tests do not silently skip. See [development](../docs/development.md) for commands and [device validation](../docs/validation.md) for the remaining platform checks.
