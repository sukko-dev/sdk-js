---
"@sukko/sdk": minor
---

Fix channel helpers to match the platform's `{tenant}.{suffix}` contract.

**Breaking** (channel helper exports): the old 3-part `{tenant}.{identifier}.{category}` model was removed platform-side (routing-rules migration), so the SDK helpers are reworked:

- `ParsedChannel` is now `{ tenant, suffix }` (was `{ tenant, identifier, category }`).
- `parseChannel(channel)` now accepts any valid 2-part channel (e.g. `acme.trades`) — previously it returned `null` for anything with fewer than 3 dot-parts. The suffix is the opaque remainder after the first dot.
- `buildChannel(tenant, suffix)` replaces `buildChannel(tenant, identifier, category)` and throws a `TypeError` on an empty tenant or suffix.
- `getChannelCategory` is removed — the platform has no channel "category" segment.

`SukkoClient` subscribe/publish behavior is unchanged (channels are opaque strings on the wire); this only affects the standalone channel helpers.
