---
"@sukko/sdk": minor
---

Expose the platform's stable message identity (`mid`) and correct edition labels.

**Stable message identity** (platform companion: klurvio/sukko#241): `Message`, `ReplayMessage`, and `PublishAck` gain an optional `mid?: string` — the stable identity of a message, IDENTICAL on every copy delivered (live broadcast, gap-replay, history), unlike the per-connection `seq` and the `pos` replay cursor. Use it to deduplicate reconnect-replay overlap (same `mid` = same message) and for idempotent processing. It is opaque (≤64 chars), never a cursor, and omitted by servers predating the field. `restPublish` now resolves with a `RestPublishResult` (`{ mid?: string }`, absent for multi-topic fan-out publishes) instead of `void` — additive, existing `await client.restPublish(...)` calls are unaffected.

**Edition corrections** (platform companion: klurvio/sukko#240): REST publish is no longer edition-gated (available on Community); push splits into Web Push (Pro) and mobile FCM/APNs (Enterprise) — previously documented as all-Enterprise; SSE remains Pro. Doc-comment corrections only; error mapping was already keyed on the `EDITION_LIMIT` error code, not blanket 403s.
