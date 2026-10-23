# @sukko/e2e — live SDK end-to-end tests

ADR-0040 **Tier2 (live)**: the real SDK (`@sukko/sdk` + `@sukko/websocket-node`) driven
against the **latest released** Sukko platform — the published GHCR images, verified by the
committed prod-signed Community license — not a source build. This is what a real user runs
against a released cluster, so a green run proves the SDK actually works, not just that its
state machines agree with a corpus (Tier1) or that it handles the current contract (L0).

## Running

```bash
bash e2e/run.sh            # all live tests
bash e2e/run.sh round-trip # a single file
```

`run.sh` orchestrates the parts the test itself must not care about:

1. Builds the `sukko` CLI (fixture tool — set `SUKKO_CLI_DIR`, or place the CLI checkout at
   `../cli` / `.sources/cli`). The CLI is the only correct way to mint the **ES256** client
   JWT the gateway accepts (its own `generate-token.ts` mints HS256, which the gateway rejects).
2. Boots a Community-direct stack from the published images (`sukko up --pull`) with the
   committed Community license, under a unique compose project; tears it down (`down -v`) on exit.
3. Provisions a fixture on the auto-created `demo` tenant: registers an ES256 signing key and
   mints a client token, written to `e2e/.fixture.json` (git-ignored).
4. Builds the SDK packages and runs the vitest suite, which reads the fixture and connects.

Requirements: `docker`, `go` (to build the CLI), `bun`. Heavy (boots Docker) — it is **not**
part of `bun test`; it runs here and on the dedicated CI lane only.

## Scope

Community-direct covers the core WS data path (connect / subscribe / publish / deliver).
SSE, gap→replay recovery, history, and push are Pro/Enterprise and/or need the kafka backend;
those cells live in the platform's edition×backend grid (ADR-0040), added as follow-up slices.
