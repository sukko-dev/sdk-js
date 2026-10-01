# ADR-0005: Translate the SSE recovery control frames to existing surfaces; defer precise per-channel recovery

**Status**: Accepted
**Date**: 2026-10-01

## Context

The platform added two SSE reconnect-recovery control frames (platform slice 3b,
`gateway.openapi` 1.0.3), delivered on the SSE stream as `event: message` with the type in
`data.type`, exactly like the existing `gap` notification:

- `{"type":"no_replay","channels":[...]}` — cursor channels the server could not replay on
  reconnect (unauthorized, no Kafka mapping on a direct backend, or the replay errored).
- `{"type":"replay_truncated","replayed":N}` — the reconnect replay was cut short at the server's
  `WS_MAX_REPLAY_MESSAGES` cap; `N` records were delivered and a gap remains.

These are **SSE-only**: the server emits them only on the gRPC `Subscribe` (SSE) path, so they
live in `gateway.openapi`, not the WS `client-ws.asyncapi.yaml` this SDK vendors. Today both frames
hit `handleMessage`'s `default` arm and are dropped as "unknown/future".

The premise of the follow-up — "the SDK silently drops recovery information" — turned out to be
wrong. On **every** SSE reopen the client already emits a synthetic `possible_gap` for *every*
desired channel (`client.ts` `handleTransportOpen`, receive-only branch), because a receive-only
transport cannot confirm live replay. That pessimistic blanket signal already covers the
`no_replay` channels (`no_replay ⊆ desired`, further narrowed by the gateway cursor∩channels
intersect, platform #34). So translating `no_replay` into another `possible_gap` would
**double-fire**.

Prior art (§XII): Centrifugo returns a `recovered` boolean per subscription (complete or failed,
never partial; `false` → use the history API); Ably sets `resumed=false` on reattach for the same
purpose. Both collapse the outcome into a binary "fully recovered vs. may-have-gap" signal — which
is what the blanket `possible_gap` already is. Neither delivers a partial recovery; Sukko
deliberately *does* (it delivers the recovered prefix and flags the remainder), so `replay_truncated`
has no exact analogue and maps to this SDK's existing truncated-recovery advisory.

## Decision

Recognize both frames in `handleMessage` (lift them out of the `default`/unknown arm) and translate
them to **existing** public surfaces — add no new wire types, leave `SERVER_MESSAGE_TYPES` and the
vendored-contract coverage test untouched:

- `replay_truncated` → emit `recoveryInterrupted` with a channel-less `RecoveryInterruptedError`
  ("reconnect replay truncated at the server cap; N delivered, a gap remains"). This is genuinely
  new information on the SSE path: the recovery timer/deadline loop never runs for a receive-only
  transport (it is armed only in the `canSend` branch of `handleTransportOpen`), and the blanket
  `possible_gap` does not carry the "cut short at the cap" fact. (A channel-scoped
  `recoveryInterrupted` can still arise on SSE if a live `gap` began a replay that a disconnect then
  truncated — a different fact, at a different time, so no duplication.)
- `no_replay` → recognized and **not** re-signaled. An explicit `case` documents that the blanket
  reopen `possible_gap` already covers its channels; classifying it as known-and-intentionally-silent
  (rather than letting it fall through as "unknown/future") is the correct contract semantics now
  that it is a defined frame.

The **precise** recovery model — trust the server's replay, drop the blanket, and emit
`possible_gap` only for the `no_replay` channels — is **rejected for now**. It is blocked on two
platform protocol gaps and is a platform-first arc (its own future ADR will supersede this one and
the blanket-signal decision):

1. **No recovery-complete sentinel.** The blanket fires at transport-open; `no_replay` arrives
   after the replayed frames. With no "recovery complete" marker, the client cannot await the
   *absence* of `no_replay` to conclude a channel was fully recovered.
2. **The quiet-channel hole.** `no_replay` is derived from the cursor (`lastPos`); a channel that
   was subscribed but received no pos-bearing message before the drop has no cursor entry, so it
   gets neither replay nor `no_replay`. The cursor is opaque to the client, so the client cannot
   compute requested-minus-cursor. Pure client-side precision would silently lose messages
   published on such a channel during the outage.

## Consequences

- Minimal, additive change: two `case` arms, no new public types, no contract/coverage churn,
  no change to `SERVER_MESSAGE_TYPES` or the vendored AsyncAPI.
- SSE clients now get an explicit, advisory `recoveryInterrupted` when the server truncates a
  reconnect replay — previously invisible on this transport.
- The blanket `possible_gap` on SSE reopen is retained and still over-signals (a false positive for
  every successfully-replayed channel). Eliminating it is the deferred precision arc, not this change.
- Companion ADRs are owed to sukko-py and sukko-go (§XVI, tracked). The truncation surface is the
  same decision in all three (each SDK's existing recovery-interrupted surface). The `no_replay`
  surface differs by SDK, according to whether that SDK already emits a blanket `possible_gap` on SSE
  reopen that subsumes `no_replay`: **this SDK (sukko-js) does** — a receive-only transport cannot
  confirm live replay — so `no_replay` is redundant here and is recognized without re-signaling.
  **sukko-py and sukko-go are optimistic** (no blanket — they trust the server's Last-Event-ID
  replay), so their companions translate `no_replay` to a per-channel `possible_gap`. Surfaces
  differ; the shared invariant is no silent recovery loss (§XVIII, documented deviation).

## Alternatives rejected

- **Add `no_replay`/`replay_truncated` as first-class wire types** (new `ServerMessage` members +
  `SERVER_MESSAGE_TYPES` entries): would force them into the WS AsyncAPI the SDK vendors —
  documenting WS frames that never flow over WS — and break the exact-match coverage test. They are
  SSE (gateway.openapi) frames; the SDK translates them, it does not re-export them.
- **Translate `no_replay` → a per-channel `possible_gap`**: double-fires against the blanket reopen
  signal (see Context).
- **Precise per-channel recovery now**: blocked on the two protocol gaps above; deferred to a
  platform-first arc.
