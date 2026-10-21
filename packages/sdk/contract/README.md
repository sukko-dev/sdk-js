# Vendored contracts

`client-ws.asyncapi.yaml` (the client WebSocket protocol) and `gateway.openapi.yaml` (the gateway
REST + SSE surface) are **pinned copies** of the authoritative Sukko platform contracts
(`../sukko/ws/docs/asyncapi/client-ws.asyncapi.yaml` and `../sukko/ws/docs/openapi/gateway.openapi.yaml`).
Their exact version + sha256 are pinned in **`CONTRACTS.lock`**.

The platform repo is the single source of truth for these contracts — this directory holds pinned
copies only, never the canonical originals.

## Why vendored

CI checks out only this repo, so the contract tests cannot reach the sibling `../sukko`. A pinned copy
makes the L0 "keep up" gate (ADR-0040) **hermetic and CI-enforceable**:

- **`pin.test.ts`** — fails when a vendored file's sha256 or declared `info.version` drifts from
  `CONTRACTS.lock` (a hand-edit or a partial re-vendor). Tamper-evident.
- **`coverage.test.ts`** — fails, not skips, when the contract declares a message type the SDK does
  not model (or vice versa), and — per message type — when its declared `code` enum does not exactly
  match the SDK's modelled error codes. Version-agnostic.
- A scheduled **sync job** (CI) that fails when the platform's *published* contract version is newer
  than the pinned one is **planned (ADR-0040), not yet shipped**; it will not use an auto-PR (the org
  blocks Actions from opening PRs).

**L0 scope today:** message `type` discriminators and per-message error `code` enums. Other contract
enums that are not `code` (e.g. `history_complete.source`) and the gateway OpenAPI's REST
endpoints / HTTP error codes / SSE control frames are not yet gated — a planned extension.

The `yaml` parser is a **devDependency** only — it never ships in the runtime bundle (the SDK ships
with zero runtime dependencies).

## Updating

When an upstream contract moves to a new version, re-vendor from a pinned platform ref and regenerate
`CONTRACTS.lock` (version + sha256 for each file), then make the SDK handle any new message types /
codes the coverage test now flags. `SUKKO_ASYNCAPI_PATH` overrides the vendored AsyncAPI path for a
local run against a live `../sukko` checkout:

```bash
SUKKO_ASYNCAPI_PATH=../../../sukko/ws/docs/asyncapi/client-ws.asyncapi.yaml bun run --filter '@sukko/sdk' test
```

## Parity vectors

The parity-vector fixtures under `vectors/` are **pinned copies** of the cross-SDK conformance corpus
whose canonical home is the platform repo (`sukko/ws/docs/conformance`, platform ADR-0023). Every SDK
vendors a checksum-pinned copy and never vendors from a sibling SDK.
