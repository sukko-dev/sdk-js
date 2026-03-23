# Research: AsyncAPI Spec Alignment

## AsyncAPI Spec Analysis (bundled.yaml v1.1.0)

### SDK Type Drift

**`PublishErrorCode`** — spec defines exactly 9 codes:
`not_available`, `invalid_request`, `invalid_channel`, `message_too_large`, `rate_limited`, `publish_failed`, `forbidden`, `topic_not_provisioned`, `service_unavailable`

SDK adds 2 extra: `no_routing_rules`, `no_matching_route`. Grep confirms these are only referenced in `packages/sdk/src/types.ts` — no tests, no example code, no downstream usage.

**`UnsubscriptionAckMessage`** — spec defines 3 fields: `type`, `unsubscribed`, `count`.
SDK adds `forced?: true`. Only referenced in `packages/sdk/src/types.ts` — no tests, no example code.

**Auth messages** — `auth` (client→server), `auth_ack`, `auth_error` (server→client) are in the SDK but not in the spec's formal message channel list. However, the spec description explicitly documents "API Key Escalation" which sends an `auth` message. Decision: **retain** — they describe real server behavior.

### Channel Format

Spec requires `{tenant}.{identifier}.{category}` with minimum 3 dot-separated parts. Tenant prefix must match JWT `tenant_id`.

Current examples use 2-part names:
- `all.trade` (public)
- `notifications.${sub}` (user-scoped)
- `community.${group}` (group-scoped)

The `decodeTokenPayload()` utility already extracts `tenant_id` from the JWT — it just isn't used for channel construction.

### Type-Safety Bugs in Examples

1. **`PublishErrorMessage`** has fields: `type`, `code`, `message`. All 3 MessageFeed components access `err.channel` — property doesn't exist.
2. **`AuthErrorMessage`** has fields: `type`, `data: { code, message }`. All 3 MessageFeed components access `err.message` — should be `err.data.message`.
