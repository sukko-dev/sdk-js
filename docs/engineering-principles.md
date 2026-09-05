# Sukko JS SDK Engineering Principles

These are the engineering principles that govern this SDK's codebase. Code
comments cite them by section: a comment like `// per §XI` refers to a section
of this document; a cited section that does not exist here (e.g. §II, §III,
§V, §IX, §XV) refers to the
[Sukko platform engineering principles](https://github.com/sukko-dev/sukko/blob/main/docs/engineering-principles.md),
which this SDK applies as its baseline. Architecture decisions are recorded
separately in [`docs/adr/`](adr/).

This is the published form of the project's internal engineering rules; the
two are kept in sync on every amendment.

> **Shared across all Sukko SDKs.** These three principles — **Contracts**, **Language Quality
> Bar**, and **Prior-Art Research** — are the *shared Sukko SDK constitution*. They hold identically
> for `@sukko/sdk` (this repo), the [Python SDK](https://github.com/sukko-dev/sdk-py), the
> [Go SDK](https://github.com/sukko-dev/sdk-go), and any future SDK, and are numbered **I / XI /
> XII** consistently across the SDKs. Every SDK keeps the same **behavioral contract** while being
> **idiomatic to its own language**; a new SDK adopts these same principles, adapted to its
> ecosystem.

## I. Contracts are the single source of truth

Every public type and every runtime behavior MUST derive from Sukko's **authoritative API
contracts** — never from the server-internal `ws/internal/shared/protocol`, and never frozen to an
older SDK's behavior. The two contracts, referenced explicitly:

- **AsyncAPI** — [`ws/docs/asyncapi/client-ws.asyncapi.yaml`](https://github.com/sukko-dev/sukko/blob/main/ws/docs/asyncapi/client-ws.asyncapi.yaml) in the platform repo — the WebSocket client protocol
  (message `type`s, payload schemas, error/close codes, auth bindings, channel format).
- **OpenAPI** — [`ws/docs/openapi/gateway.openapi.yaml`](https://github.com/sukko-dev/sukko/blob/main/ws/docs/openapi/gateway.openapi.yaml) in the platform repo — the REST surface (publish, auth,
  SSE, push), status/error codes, and payload limits.

Wire `type` strings, field names, error codes, close codes, and limits MUST match the contracts
**exactly**. When the contract and this SDK's current behavior disagree, **the contract wins** and
the drift is filed upstream — never silently matched to the stale side. A **contract-coverage test**
SHOULD assert every protocol message has a typed representation.

## XI. Language quality bar — idiomatic, robust, performant, secure

The implementation MUST be **idiomatic to TypeScript/JavaScript and its ecosystem** — not a
transliteration of a sibling SDK. Beyond idiom, every change MUST clear five bars:

- **Idiomatic** — `strict` + `isolatedDeclarations` (explicit exported types), `verbatimModuleSyntax`,
  no `any` (suppressions justified), dual ESM+CJS via tsup, passes Biome lint/format. Transport-
  and framework-agnostic core; SSR-safe bindings (no `window`/`document`/`localStorage` at module
  scope).
- **Robust** — typed errors and no silent failures, graceful degradation, deterministic teardown
  (no dangling timers/listeners/sockets), inputs validated at every boundary. Edge cases (empty,
  null, max, error paths, cancellation, reconnect) covered by Vitest.
- **Performant** — the message-delivery path is the hot path: no needless allocation or
  re-serialization, back-pressure over unbounded buffering (capability-gated per transport — WHATWG
  sockets auto-drain, a `ws`-backed Node transport can `pause()`/`resume()`), feature work never
  blocks delivery.
- **Secure** — credentials never appear in logs, thrown errors, or serialized state; header-default
  auth where the runtime allows it; validate untrusted server input before acting on it.
- **No dead code** — every code path, capability branch, exported symbol, and message/struct field
  MUST be reachable and exercised. A discovered dead or unreachable path MUST be **removed** (or made
  reachable), never merely guarded around; a degenerate never-taken branch is a bug, not defensive
  coding. No stub/no-op implementations ship — unbuilt work stays out of scope, not empty
  scaffolding. Enforced as part of definition-of-done by `tsc` (`noUnusedLocals`/`noUnusedParameters`)
  and Biome (`noUnusedVariables`/`noUnusedImports`), with tree-shakeable ESM (`sideEffects: false`).

Every SDK shares the same **behavioral contract**; they need not share code shape. Correctness over
pattern — if a sibling SDK does it wrong, fix it there too; don't copy the defect.

## XII. Prior-art & industry research — mandatory, every change

**Before designing any feature, fixing any bug, or making any improvement**, research how the
problem is already solved — **on the internet, not from memory** (docs and training data go stale).
Research and briefly document:

1. **The common industry pattern** — how established real-time clients solve it: Pusher, Ably,
   Socket.IO, Phoenix Channels, Centrifugo, PubNub, and the platform's own prior art.
2. **Failure modes & edge cases** mature implementations handle (reconnect storms, token races,
   back-pressure, partial recovery, message ordering, idempotency).
3. **Ecosystem norms** — WHATWG vs `ws` WebSocket semantics, ESM/CJS interop, `.d.ts` shape,
   framework-binding conventions (React `useSyncExternalStore`, Vue reactivity, Svelte stores).
4. **Where and why this SDK deviates** from the common pattern.

"Not invented here" solutions to already-solved problems are forbidden. A change without this
research is incomplete — cite the sources (PR description or a code comment).

## XIII. Decision Records

Durable engineering decisions are recorded as Architecture Decision Records in
[`docs/adr/`](adr/) — any choice that is likely to be challenged, expensive to reverse, or
needed by a future contributor MUST be recorded at the moment it is made. Accepted ADRs are
never edited — they are superseded by new ones. ADRs capture the decision, its context and
consequences, and the rejected alternatives.

Planning artifacts are ephemeral — there are no per-feature specification or plan documents
in the repository; the durable outputs of design work are ADRs and committed documentation.
