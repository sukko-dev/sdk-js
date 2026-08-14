# Vendored contract

`client-ws.asyncapi.v1.4.0.yaml` is a **version-pinned copy** of the authoritative AsyncAPI client-WS
protocol (`../sukko/ws/docs/asyncapi/client-ws.asyncapi.yaml`, version `1.4.0`).

## Why vendored

CI checks out only this repo, so the contract-coverage test (`coverage.test.ts`, FR-016/SC-004) cannot
reach the sibling `../sukko` repo. A vendored copy makes the test **hermetic and CI-enforceable** — it
fails, not skips, when a message type is added or renamed. The `yaml` parser is a **devDependency**
only (it never ships in the runtime bundle — NFR-002 zero-runtime-dep).

## Updating

When the upstream contract moves to a new version, re-copy the file, bump the `v1.4.0` in the filename,
and update the coverage test's expected version. The `SUKKO_ASYNCAPI_PATH` env var overrides the
vendored path for local runs against a live `../sukko` checkout:

```bash
SUKKO_ASYNCAPI_PATH=../../../sukko/ws/docs/asyncapi/client-ws.asyncapi.yaml bun run --filter '@sukko/sdk' test
```

The parity-vector fixtures under `vectors/` (NFR-007) are **canonical here** — the Python SDK vendors a
checksummed copy when it adopts the corrected behavior.
