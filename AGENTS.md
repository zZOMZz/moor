# Moor contributor guidelines

Moor is an independent, local-first client and self-hosted relay built on Lody's public runtime.
Lody stays an unmodified, pinned external checkout. Its OSS desktop remains local-only.

- Use the public local IPC v7 and session schemas; never read Lody SQLite files directly.
- Only the execution host imports and persists user CRDT operations. The relay stores no session bodies.
- Bind every request to account, device, workspace, project and session.
- Keep credentials out of shared documents. Never expose a raw shell or socket proxy.
- Offline drafts never execute on reconnect. Retries use the original operation id and require a manual action.
- Delivery requires host confirmation. Approvals must match the exact active turn and request.
- Test with synthetic data and deterministic signals or injected timers, never real agent accounts or sleeps.
- Never commit transcripts, secrets, local databases, generated bundles or internal task records.
- Run pnpm check, pnpm test, pnpm build and pnpm format:check before committing.
- Keep dependency versions locked. Preserve third-party license notices and provenance.
- Use Conventional Commit subjects. State real-device validation limits explicitly.
