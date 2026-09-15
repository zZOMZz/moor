# Tests

- `integration/`: cross-package, cross-process and product-boundary Node tests.
- `e2e/`: entry point and status notes for real Electron and device validation.
- `fixtures/`: synthetic Agents, relays, service adapters and UI fixtures shared by tests.

Package- and app-local unit tests live beside their owning workspace. The root
`pnpm test` command discovers both workspace tests and this integration tree.
