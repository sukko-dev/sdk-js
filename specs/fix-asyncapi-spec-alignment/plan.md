# Implementation Plan: AsyncAPI Spec Alignment

**Branch**: `fix/asyncapi-spec-alignment` | **Date**: 2026-03-23 | **Spec**: `specs/fix-asyncapi-spec-alignment/spec.md`

## Summary

Remove stale error codes and fields from SDK types that aren't in the AsyncAPI spec, fix example channel names to use 3-part tenant-prefixed format, and fix type-safety bugs in example error handlers.

## Technical Context

**Language**: TypeScript 5.5+ (strict, isolatedDeclarations)
**Build**: Bun workspaces, tsup (dual ESM + CJS)
**Test**: Vitest
**Lint**: Biome (tabs, double quotes, semicolons, trailing commas)

## Constitution Check

| Principle | Status |
|-----------|--------|
| isolatedDeclarations — explicit export annotations | PASS — no new exports |
| No `any` | PASS — no `any` introduced |
| Biome formatting | PASS — will verify with `bun run lint` |
| Test coverage for changes | PASS — removed codes/fields have no tests; example changes are UI-only |
| Zero runtime deps for SDK | PASS — no deps added |
| SSR-safe bindings | PASS — no SSR behavior changed |

## Changes

### 1. SDK: `packages/sdk/src/types.ts`

**1a. Remove extra `PublishErrorCode` members**

```diff
 export type PublishErrorCode =
 	| "not_available"
 	| "invalid_request"
 	| "invalid_channel"
 	| "message_too_large"
 	| "rate_limited"
 	| "publish_failed"
 	| "forbidden"
 	| "topic_not_provisioned"
-	| "service_unavailable"
-	| "no_routing_rules"
-	| "no_matching_route";
+	| "service_unavailable";
```

**1b. Remove `forced` from `UnsubscriptionAckMessage`**

```diff
 export interface UnsubscriptionAckMessage {
 	type: "unsubscription_ack";
 	unsubscribed: string[];
 	count: number;
-	forced?: true;
 }
```

### 2. Examples: Channel naming with tenant prefix

**Files** (identical pattern in each):
- `examples/chat-react/src/components/ChannelSidebar.tsx`
- `examples/chat-vue/src/components/ChannelSidebar.vue`
- `examples/chat-svelte/src/components/ChannelSidebar.svelte`

**Pattern**: Derive `tenant` from `claims.tenant_id ?? "sukko"`, then prefix all channels.

React example (others follow same pattern):
```diff
+ const tenant = claims.tenant_id ?? "sukko";
+
- const publicChannels = ["all.trade"];
- const userChannels = claims.sub ? [`notifications.${claims.sub}`] : [];
+ const publicChannels = [`${tenant}.all.trade`];
+ const userChannels = claims.sub ? [`${tenant}.notifications.${claims.sub}`] : [];
  ...
- const allSubscribed = [...publicChannels, ...userChannels, ...joinedGroups.map((g) => `community.${g}`)];
+ const allSubscribed = [...publicChannels, ...userChannels, ...joinedGroups.map((g) => `${tenant}.community.${g}`)];
```

All group channel references (`community.${group}`) must also be prefixed:
- Channel construction in join/leave handlers
- Display text in unjoined group items
- Selected channel comparisons

### 3. Examples: Fix MessageFeed error handlers

**Files** (identical pattern in each):
- `examples/chat-react/src/components/MessageFeed.tsx`
- `examples/chat-vue/src/components/MessageFeed.vue`
- `examples/chat-svelte/src/components/MessageFeed.svelte`

**3a. `publishError` handler — remove `err.channel` access**

```diff
  useSukkoEvent("publishError", (err) => {
    props.onMessage({
      id: createMessageId(),
-     channel: err.channel ?? "",
+     channel: "",
      sender: "system",
```

**3b. `authError` handler — fix `err.message` → `err.data.message`**

```diff
  useSukkoEvent("authError", (err) => {
    props.onMessage({
      ...
-     text: `Auth error: ${err.message ?? "Token refresh failed"}`,
+     text: `Auth error: ${err.data.message ?? "Token refresh failed"}`,
```

## Files Modified

| File | Change |
|------|--------|
| `packages/sdk/src/types.ts` | Remove 2 error codes, remove `forced` field |
| `examples/chat-react/src/components/ChannelSidebar.tsx` | Add tenant prefix to channels |
| `examples/chat-react/src/components/MessageFeed.tsx` | Fix `publishError` and `authError` handlers |
| `examples/chat-vue/src/components/ChannelSidebar.vue` | Add tenant prefix to channels |
| `examples/chat-vue/src/components/MessageFeed.vue` | Fix `publishError` and `authError` handlers |
| `examples/chat-svelte/src/components/ChannelSidebar.svelte` | Add tenant prefix to channels |
| `examples/chat-svelte/src/components/MessageFeed.svelte` | Fix `publishError` and `authError` handlers |

## Verification

```bash
bun run build    # All packages compile
bun run test     # All tests pass
bun run lint     # Biome formatting clean
```
