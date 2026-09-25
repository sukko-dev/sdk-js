# @sukko/sdk

## 2.0.0

### Minor Changes

- fd94001: Add API-key authentication. A new `apiKey` client option authenticates with an API key (the JWT
  alternative, matching the Go and Python SDKs). Over WebSocket the browser transport sends
  credentials as `?token=`/`?api_key=` query params (browsers cannot set WebSocket request headers)
  and the Node transport sends them as `Authorization: Bearer`/`X-API-Key` headers; SSE and REST use
  those headers. The Node WebSocket transport now sends the JWT as an `Authorization` header instead
  of a `?token=` query param (both are gateway-accepted; headers avoid logging the credential in
  URLs). A JWT always takes precedence over an API key, so `escalate()` continues to upgrade an
  API-key session to a JWT.

### Patch Changes

- 7b5abbb: Suspend the recovery detection deadline while the delivery consumer is backpressured. Previously a slow consumer could pause the transport during a replay (or history), stopping recovery frames, so the idle deadline would fire and raise a spurious `RecoveryInterrupted` even though the server was fine. The deadline now detects server silence, not consumer speed — it suspends while stalled and re-arms on resume (platform ADR-0025), matching sukko-go and sukko-py.

## 1.0.0

### Minor Changes

- 701f34a: Fix channel helpers to match the platform's `{tenant}.{suffix}` contract.

  **Breaking** (channel helper exports): the old 3-part `{tenant}.{identifier}.{category}` model was removed platform-side (routing-rules migration), so the SDK helpers are reworked:

  - `ParsedChannel` is now `{ tenant, suffix }` (was `{ tenant, identifier, category }`).
  - `parseChannel(channel)` now accepts any valid 2-part channel (e.g. `acme.trades`) — previously it returned `null` for anything with fewer than 3 dot-parts. The suffix is the opaque remainder after the first dot.
  - `buildChannel(tenant, suffix)` replaces `buildChannel(tenant, identifier, category)` and throws a `TypeError` on an empty tenant or suffix.
  - `getChannelCategory` is removed — the platform has no channel "category" segment.

  `SukkoClient` subscribe/publish behavior is unchanged (channels are opaque strings on the wire); this only affects the standalone channel helpers.

- 82e1143: Expose the platform's stable message identity (`mid`) and correct edition labels.

  **Stable message identity** (platform companion: sukko-dev/sukko#241): `Message`, `ReplayMessage`, and `PublishAck` gain an optional `mid?: string` — the stable identity of a message, IDENTICAL on every copy delivered (live broadcast, gap-replay, history), unlike the per-connection `seq` and the `pos` replay cursor. Use it to deduplicate reconnect-replay overlap (same `mid` = same message) and for idempotent processing. It is opaque (≤64 chars), never a cursor, and omitted by servers predating the field. `restPublish` now resolves with a `RestPublishResult` (`{ mid?: string }`, absent for multi-topic fan-out publishes) instead of `void` — additive, existing `await client.restPublish(...)` calls are unaffected.

  **Edition corrections** (platform companion: sukko-dev/sukko#240): REST publish is no longer edition-gated (available on Community); push splits into Web Push (Pro) and mobile FCM/APNs (Enterprise) — previously documented as all-Enterprise; SSE remains Pro. Doc-comment corrections only; error mapping was already keyed on the `EDITION_LIMIT` error code, not blanket 403s.
