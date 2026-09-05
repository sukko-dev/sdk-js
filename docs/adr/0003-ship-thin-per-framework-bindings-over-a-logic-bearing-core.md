# ADR-0003: Ship thin per-framework binding packages over a logic-bearing core

**Status**: Accepted
**Date**: 2026-08-21
**Ticket**: feat/sdk-contract-parity, general repo structure

## Context

Sukko targets React, Vue, Svelte, and React Native consumers, each with its own idiomatic reactivity primitive (React `useSyncExternalStore`, Vue `provide`/`inject` + reactive refs, Svelte readable stores). The SDK must give each framework a native-feeling API without forking connection, recovery, auth, or push logic per framework. Framework bindings also re-export the core, so any core module that touches a browser global at import time would transitively break their SSR-safety guarantee. (The rationale for *separate* packages over one universal binding package is reconstructed from the repo structure and dependency rules; the "logic-in-core, thin bindings" rationale below is documented.)

## Decision

All connection, protocol, recovery, auth, back-pressure, and push *logic* lives in `@sukko/sdk`; framework packages (`@sukko/react`, `@sukko/vue`, `@sukko/svelte`, `@sukko/react-native`) are thin, idiomatic adapters that consume the core and re-export its types for convenience. Each package has a single `src/index.ts` barrel and produces dual ESM+CJS builds. Framework bindings MUST be SSR-safe — no `window`/`document`/`localStorage`/`navigator` access at module scope — which forces the core (including its SSE and push modules) to keep every browser-global access inside call-time capability checks. Cross-cutting features land symmetrically: push subscription-management and `enableWebPush` live in core so the three web bindings need *zero* per-framework push code; `@sukko/react-native` adds only the mobile-specific `enableMobilePush` + injected `MessagingAdapter`. Frameworks are peer dependencies, never runtime dependencies.

## Consequences

- Easier: a core feature reaches all frameworks at once; each binding stays small and idiomatic; SSR/import-safety is enforceable by a Node-no-DOM import test.
- Harder: adding a framework means a new package (and a new entry in the explicit two-phase build list); the SSR constraint on core is load-bearing and permanent — a single module-scope browser-global access silently breaks every binding's SSR guarantee.
- Coupling: bindings are pinned to the core via version-linked Changesets; a core-type rename ripples through every re-exporting binding.

## Alternatives rejected

- **One universal framework-agnostic binding package** — could not offer each framework its native reactivity primitive; rejected in favor of idiomatic per-framework adapters (rationale reconstructed from repo structure, not argued in prose).
- **Per-framework feature code (e.g. push logic duplicated in each binding)** — multiplies surface and drift; feature logic is centralized in core.
- **Framework libraries as runtime dependencies** — would force a framework choice on consumers; they are peer dependencies instead.
