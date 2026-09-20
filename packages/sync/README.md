# @moor/sync

Host-owned State Plane persistence for the versioned Loro TaskDoc. It validates
scoped author edits, persists shared documents and exports version-vector deltas.
It does not interpret submission or withdrawal as queue transitions and does not
recover or dispatch Agent work.

The execution coordinator and private ledger live in `@moor/host`. They publish
Host-authored execution state into TaskDoc atomically with ledger changes. The
relay does not depend on this package and never stores collaborative content.

See [interface semantics](../../docs/interface-semantics.md) for contracts and migration.
