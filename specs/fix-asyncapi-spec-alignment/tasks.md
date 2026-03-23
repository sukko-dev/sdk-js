# Tasks: AsyncAPI Spec Alignment

**Branch**: `fix/asyncapi-spec-alignment`
**Generated**: 2026-03-23
**Total tasks**: 9 (Phase 1: 1, Phase 2: 6, Phase 3: 2)

---

## Phase 1: SDK Types

- [ ] T001 Remove `no_routing_rules` and `no_matching_route` from `PublishErrorCode` and remove `forced?: true` from `UnsubscriptionAckMessage` in `packages/sdk/src/types.ts`

## Phase 2: Example Apps (depends on T001)

### Channel naming — tenant prefix

- [ ] T002 [P] Add tenant prefix to all channel names in `examples/chat-react/src/components/ChannelSidebar.tsx`: derive `tenant` from `claims.tenant_id ?? "sukko"`, prefix `publicChannels`, `userChannels`, group channels in `allSubscribed`, and update all `community.${group}` references in join/leave handlers and display text
- [ ] T003 [P] Add tenant prefix to all channel names in `examples/chat-vue/src/components/ChannelSidebar.vue`: add `const tenant = computed(() => claims.value.tenant_id ?? "sukko")`, convert `publicChannels` from plain `const` to `computed(() => [\`${tenant.value}.all.trade\`])`, update `userChannels` and `groupChannels` computed to use `tenant.value` prefix, and update all `community.${group}` references in join/leave handlers and template to use `${tenant.value}.community.${group}`
- [ ] T004 [P] Add tenant prefix to all channel names in `examples/chat-svelte/src/components/ChannelSidebar.svelte`: add `const tenant = $derived(claims.tenant_id ?? "sukko")`, convert `publicChannels` from plain `const` to `$derived([\`${tenant}.all.trade\`])`, update `userChannels` and `groupChannels` derived to use `tenant` prefix, and update all `community.${group}` references in join/leave functions and template to use `${tenant}.community.${group}`

### Error handler fixes

- [ ] T005 [P] Fix error handlers in `examples/chat-react/src/components/MessageFeed.tsx`: change `err.channel ?? ""` to `""` in `publishError` handler, change `err.message` to `err.data.message` in `authError` handler
- [ ] T006 [P] Fix error handlers in `examples/chat-vue/src/components/MessageFeed.vue`: change `err.channel ?? ""` to `""` in `publishError` handler, change `err.message` to `err.data.message` in `authError` handler
- [ ] T007 [P] Fix error handlers in `examples/chat-svelte/src/components/MessageFeed.svelte`: change `err.channel ?? ""` to `""` in `publishError` handler, change `err.message` to `err.data.message` in `authError` handler

## Phase 3: Verification (depends on all above)

- [ ] T008 Run `bun run build && bun run test` to verify all packages compile and tests pass
- [ ] T009 Run `bun run lint` to verify Biome formatting is clean

---

## Dependencies

```
T001 ──┬──> T002 ─┐
       ├──> T003 ─┤
       ├──> T004 ─┤
       ├──> T005 ─┼──> T008 ──> T009
       ├──> T006 ─┤
       └──> T007 ─┘
```

## Parallel Opportunities

- **T002–T007** are all independent (different files, no shared state) — can execute in parallel after T001
- **T008–T009** are sequential (lint after build+test confirms correctness)
