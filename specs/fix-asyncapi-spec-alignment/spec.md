# Feature Specification: AsyncAPI Spec Alignment

**Branch**: `fix/asyncapi-spec-alignment`
**Created**: 2026-03-23
**Status**: Draft

## Context

The Sukko server's AsyncAPI spec (`bundled.yaml` v1.1.0) is the authoritative definition of the WebSocket protocol. The TypeScript SDK types and all three example chat apps have drifted from this spec in three areas:

1. **SDK types contain error codes and fields not present in the spec** — `PublishErrorCode` includes `no_routing_rules` and `no_matching_route`; `UnsubscriptionAckMessage` includes `forced?: true`. These were likely added during development but were never adopted by the server.
2. **Example apps use invalid channel names** — All examples use 2-part channels (e.g., `all.trade`) but the spec mandates a minimum of 3 dot-separated parts with a tenant prefix: `{tenant}.{identifier}.{category}`.
3. **Example apps have type-safety bugs** — `publishError` handlers access a non-existent `channel` property; `authError` handlers access `message` at the wrong nesting level.

Aligning the SDK and examples to the spec ensures consumers build against the real protocol and examples work correctly when connected to a Sukko server.

## User Scenarios

### Scenario 1 — SDK types match the server protocol exactly (Priority: P1)

A developer imports `PublishErrorCode` from `@sukko/sdk` and uses it in a switch/exhaustive check. The type should contain exactly the error codes the server can return — no more, no less.

**Acceptance Criteria**:
1. **Given** the SDK `PublishErrorCode` type, **When** a developer inspects its members, **Then** it contains exactly: `not_available`, `invalid_request`, `invalid_channel`, `message_too_large`, `rate_limited`, `publish_failed`, `forbidden`, `topic_not_provisioned`, `service_unavailable`.
2. **Given** the SDK `UnsubscriptionAckMessage` type, **When** a developer inspects its fields, **Then** it contains only `type`, `unsubscribed`, and `count` — no `forced` field.
3. **Given** the existing SDK build, **When** `bun run build` is executed, **Then** all packages compile without errors.
4. **Given** the existing test suite, **When** `bun run test` is executed, **Then** all tests pass.

### Scenario 2 — Example apps use valid tenant-prefixed channels (Priority: P1)

A developer runs any example chat app with a JWT containing `tenant_id: "acme"`. When channels are subscribed, they must use the 3-part tenant-prefixed format that the server expects.

**Acceptance Criteria**:
1. **Given** a JWT with `tenant_id: "acme"` and `sub: "alice"`, **When** the channel sidebar renders, **Then** public channels are `acme.all.trade`, user channels are `acme.notifications.alice`, and group channels are `acme.community.{group}`.
2. **Given** no JWT is provided (or a JWT without `tenant_id`), **When** the channel sidebar renders, **Then** channels fall back to a default tenant prefix (e.g., `sukko`).
3. **Given** channels are displayed in the sidebar and message feed, **When** a user reads them, **Then** they see the full tenant-prefixed channel name.

### Scenario 3 — Example error handlers access correct properties (Priority: P1)

Event handlers in all three example apps must reference properties that actually exist on the SDK's message types, so they display meaningful error information to the user.

**Acceptance Criteria**:
1. **Given** a `publishError` event fires, **When** the MessageFeed handler runs, **Then** it does NOT access a `channel` property on the error (the type has no such field) and the channel field in the rendered message is empty string.
2. **Given** an `authError` event fires, **When** the MessageFeed handler runs, **Then** it accesses `err.data.message` (not `err.message`) to display the error text.
3. **Given** the example apps and SDK, **When** `bun run build` is executed, **Then** all packages including examples compile without type errors.

### Edge Cases
- What happens when the JWT has no `tenant_id` claim? Channels should use a default tenant prefix (`"sukko"`).
- What happens when `err.data.message` is undefined on an auth error? The fallback string `"Token refresh failed"` should still display.

## Requirements

### Functional Requirements

- **FR-001**: `PublishErrorCode` MUST contain exactly the 9 error codes defined in the AsyncAPI spec's `publish_error.code` enum.
- **FR-002**: `UnsubscriptionAckMessage` MUST NOT contain a `forced` field.
- **FR-003**: All example channel names MUST follow the `{tenant}.{identifier}.{category}` format (minimum 3 dot-separated parts).
- **FR-004**: Example channels MUST derive the tenant prefix from the decoded JWT's `tenant_id` claim, falling back to `"sukko"` when absent.
- **FR-005**: `publishError` handlers in examples MUST NOT access properties absent from `PublishErrorMessage`.
- **FR-006**: `authError` handlers in examples MUST access `err.data.message` instead of `err.message`.
- **FR-007**: Auth-related types (`AuthRefreshMessage`, `AuthAckMessage`, `AuthErrorMessage`) MUST be retained — they are implied by the spec's "API Key Escalation" section.

### Non-Functional Requirements

- **NFR-001**: All changes MUST pass `bun run build`, `bun run test`, and `bun run lint` with no regressions.
- **NFR-002**: Changes MUST be backwards-compatible at the runtime level — removing union members from `PublishErrorCode` is a compile-time narrowing, not a runtime break.

### Key Entities

- **PublishErrorCode**: Union type of machine-readable error codes the server can return on a failed publish.
- **UnsubscriptionAckMessage**: Server message confirming channel unsubscriptions, with subscribed/count fields.
- **Channel name**: String in `{tenant}.{identifier}.{category}` format, minimum 3 dot-separated segments.

## Success Criteria

- **SC-001**: `PublishErrorCode` has exactly 9 members matching the AsyncAPI spec.
- **SC-002**: `UnsubscriptionAckMessage` has no `forced` field.
- **SC-003**: All example channel names contain at least 3 dot-separated parts with a tenant prefix derived from the JWT.
- **SC-004**: `bun run build && bun run test && bun run lint` passes cleanly.

## Out of Scope

- Adding new message types not currently in the SDK (the spec and SDK are otherwise aligned).
- Changing the `auth`/`auth_ack`/`auth_error` message types (they are implied by the spec even if not formally in the channels section).
- Updating the `@sukko/websocket` transport adapter (no protocol-level changes needed).
- Modifying framework binding packages (`@sukko/react`, `@sukko/vue`, `@sukko/svelte`) beyond what's needed in the example apps.
