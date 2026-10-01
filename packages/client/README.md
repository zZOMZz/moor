# @moor/client

Scoped request construction, Host response validation and original-operation rules.
Shared functions consume narrow capability interfaces and common request-delivery
evidence. Browser and Node implementations use explicit `adapters/` entries;
credentials remain in the owning adapter rather than application state.

Public source exports are declared individually in the manifest. Removed root and
`node/` transport paths have no compatibility aliases. Workspace message contracts
live in `@moor/protocol`; private Node connection files and locks live in
`@moor/local-state`. The package does not depend on Host, gateway or application source.
