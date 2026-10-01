# @moor/gateway

Account and product-directory policy, authentication flows, authorization rechecks,
and typed target dispatch live in `features/`. These modules consume their own
record, credential, provider and connection interfaces. A connection version is
opaque identity evidence; the core never receives a socket or a SQL connection.

`adapters/http/server` composes Node HTTP/WebSocket ingress with these features.
`adapters/composition/accounts` owns one SQLite connection shared by accounts,
catalogue and notification records; nested snapshot and logout transactions keep
their original atomic boundaries. Password derivation, provider verification,
subscription validation, transport framing and static files stay in adapters.
Applications provide OIDC and push implementations when configured.

Every asynchronous command rechecks the original login, device, project assignment
and connection before returning a validated Host receipt. Notification records
contain routing metadata and bounded delivery evidence, never session bodies.
The package neither imports Host execution nor owns session persistence. Public
exports list canonical modules individually; former root paths have been removed.
