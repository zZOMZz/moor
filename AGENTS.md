# Moor contributor guidelines

Moor is an independent, local-first client, execution host and self-hosted relay.
Moor owns its session schema and persistence; pinned ACP adapters connect local coding agents.

- Use Moor's versioned session schema and typed host boundary. Never read another application's databases or depend on an external source checkout.
- Only the execution host imports and persists user CRDT operations. The relay stores no session bodies.
- Bind every request to account, device, workspace, project and session.
- Keep credentials out of shared documents. Never expose a raw shell or socket proxy.
- Offline drafts never execute on reconnect. Retries use the original operation id and require a manual action.
- Delivery requires host confirmation. Approvals must match the exact active turn and request.
- Test with synthetic data and deterministic signals or injected timers, never real agent accounts or sleeps.
- Never commit transcripts, secrets, local databases, generated bundles or internal task records.
- Relay archives and Docker contexts include only packaged program files. Preserve operator data when rebuilding a package; never include it in distribution artifacts.
- Run pnpm check, pnpm test, pnpm build and pnpm format:check before committing.
- Keep dependency versions locked. Preserve third-party license notices and provenance.
- Use Conventional Commit subjects. State real-device validation limits explicitly.
