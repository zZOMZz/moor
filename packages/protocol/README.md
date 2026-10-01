# @moor/protocol

Versioned Moor request, response, event and scope contracts. This package contains
pure schemas, validation, workspace message contracts and public request-delivery
evidence. It must not import application, host, persistence, Node I/O, Electron,
React or CRDT implementations. Node private connection files and lifetime locks
belong to `@moor/local-state`, not a protocol subpath.
