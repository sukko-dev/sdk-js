# ADR-0001: Split transport behind an interface with capability-gated back-pressure

**Status**: Accepted
**Date**: 2026-08-21
**Ticket**: feat/sdk-contract-parity, feat/push-framework-upgrade (backlog)

## Context

`@sukko/sdk` is a zero-runtime-dependency, transport-agnostic core that must run in browsers, Node, and React Native. WHATWG `WebSocket` (browser and Node global) is push-only — it auto-drains and cannot apply read back-pressure — while Node's `ws` library can pause the TCP socket. The core needs one connection abstraction that spans both without leaking a Node-only dependency into browser bundles, and without runtime environment sniffing. This split is defined and partly built (the `Transport` interface plus `@sukko/websocket` ship today; `@sukko/websocket-node` and the `pause()`/`resume()` core branch are in-flight under the contract-parity work).

## Decision

A single `Transport` interface (`packages/sdk/src/transport.ts` → `transport/base.ts`) exposes `open`/`close`/`send`/`setToken`, `state`, and a `TransportCapabilities` object (`canSend`, `canPauseReceive`, plus `pause()`/`resume()`). The core branches on the declared capability, never on the runtime. Each protocol adapter is its own package: `@sukko/websocket` (WHATWG, `canPauseReceive: false`, no-op pause/resume, dependency-free) and `@sukko/websocket-node` (`ws`-backed, `canPauseReceive: true`, real socket pause/resume, `ws` as a peer dependency). A transport's class — and therefore its capabilities — is fixed for the client's lifetime; there is no automatic WS↔SSE fallback in v1. SSE is the deliberate exception: it lives *in core* over `fetch` streaming rather than as a transport package, so it adds no dependency and needs no `EventSource`.

## Consequences

- Easier: browser builds never pull in `ws`; a capable transport gets true end-to-end back-pressure while an incapable one falls back to a bounded queue with an explicit `overflowPolicy` and an in-band `Overflow` marker (never a silent drop); the capability branch is unit-testable with fakes.
- Harder: the `canPauseReceive: true` path was dormant until `@sukko/websocket-node` existed (no transport exercised it), so it must be verified end-to-end; a fixed-per-lifetime transport means switching protocols requires a new client.
- Coupling: SSE-in-core means core carries a `fetch`-based reader and its browser-global access must stay call-time-guarded (SSR/import-safety), because framework packages re-export core.

## Alternatives rejected

- **A Node-only export subpath instead of a separate `@sukko/websocket-node`** — bundlers could pull `ws` into browser builds; a separate package makes the boundary physical.
- **Runtime environment sniffing to pick pause behavior** — hidden branching; capability is declared per transport instead.
- **SSE as its own transport package** — would add a dependency and a package for a `fetch`-only reader that belongs in the zero-dep core.
- **Automatic WS↔SSE fallback** — a client's `canPauseReceive` contract would change mid-lifetime; deferred past v1.
