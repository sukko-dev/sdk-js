# ADR-0002: Derive the SDK from versioned contracts, prove parity with scenario vectors

**Status**: Accepted
**Date**: 2026-08-21
**Ticket**: feat/sdk-contract-parity

## Context

Sukko ships multiple SDKs (this TypeScript repo, `sukko-py`, future languages) against one Go platform. Each must present the *same behavioral contract* while staying idiomatic to its language. Two authoritative documents define the wire surface: the AsyncAPI client-WS protocol (`../sukko/ws/docs/asyncapi/client-ws.asyncapi.yaml`) and the gateway OpenAPI REST surface (`../sukko/ws/docs/openapi/gateway.openapi.yaml`). `@sukko/sdk` currently lags AsyncAPI v1.4.0 (no back-pressure, gap-dropping resubscribe, no auth refresh/SSE/push); the contract-parity work brings it into conformance and is mid-flight.

## Decision

Every public type and runtime behavior derives from the AsyncAPI/OpenAPI contracts. Wire `type` strings, field names, error codes, close codes, and limits match the contracts exactly. When current SDK behavior and the contract disagree, the contract wins and the drift is filed upstream — never silently matched to the stale side. A contract-coverage test parses a **vendored, v1.4.0-version-pinned** copy of the AsyncAPI YAML (a `SUKKO_ASYNCAPI_PATH` override allows local cross-repo runs) and fails if any enumerated message (18 server + 8 client) lacks a typed model with the exact wire `type`. Cross-SDK parity is proven by a **language-neutral scenario-vector set** (JSON with time-advance events and a canonical snake_case action encoding) that each SDK replays through pure state machines — the SDKs share the behavioral contract without sharing code. `sukko-py` is the behavioral reference, not external prior art and not a code source; where the reference itself is wrong, this SDK specifies the correct behavior and owes a fix back.

## Consequences

- Easier: a renamed/added protocol message fails CI hermetically (single-checkout, no sibling clone needed); two SDKs can be shown equivalent on shared scenarios; idioms diverge freely per language.
- Harder: the vendored contract copy must be re-pinned when the platform bumps the AsyncAPI version; every timing path must route through an injectable clock/RNG so vectors are deterministically replayable; discovered drift becomes upstream filings to track (e.g. 64KB-vs-1MB publish limit, string-form `device_id`).
- Coupling: SDK behavior is bound to a specific contract version, not to whatever the server currently does or an older SDK did.

## Alternatives rejected

- **Deriving types from the server-internal `ws/internal/shared/protocol`** — explicitly forbidden; it is not the authoritative contract.
- **Freezing to an older SDK's behavior** — locks in drift; the contract is the source of truth.
- **Referencing the sibling `../sukko` contract live at test time** — breaks hermetic single-checkout CI; a vendored pinned copy is checked in instead.
- **A shared cross-language core / codegen** — parity is asserted by replayed scenario vectors, keeping each SDK idiomatic; shared code shape was not pursued.
