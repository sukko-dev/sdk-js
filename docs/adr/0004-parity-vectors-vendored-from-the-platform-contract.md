# ADR-0004: Parity vectors are vendored from the platform contract; no SDK is the behavioral reference

**Status**: Accepted
**Date**: 2026-09-22
**Supersedes (in part)**: ADR-0002 — its "canonical home in this repo" location clause and its "`sukko-py` is the behavioral reference" wording

## Context

ADR-0002 established the right principle — derive from the versioned AsyncAPI/OpenAPI contracts,
prove cross-SDK parity with a language-neutral scenario-vector set — but made two choices that
put this repo out of step with its siblings:

1. It declared `@sukko/sdk` the **canonical home** for the vector corpus, with `sukko-py`
   expected to vendor the corpus *from here*. No fixtures were ever authored.
2. It named **`sukko-py` the behavioral reference**. That directly contradicts sukko-py ADR-0001
   ("Neither SDK is the behavioral reference: both converge on the contract") and sukko-go
   ADR-0003 (derive from the contract, never from a sibling — a rule written after a
   copied-from-sibling clause caused silent data loss).

The platform has since made the corpus a contract artifact housed with the AsyncAPI
(platform ADR-0023).

## Decision

This SDK vendors the parity-vector corpus from the **platform contract**, exactly as it already
vendors the pinned AsyncAPI: a checksum-pinned copy under this repo's test data, refreshed by
copy-record-verify, replayed through the pure state machines. This repo is **not** the corpus's
home and **not** the behavioral reference for any other SDK. When a vector and this SDK disagree,
the vector (contract) wins and this SDK is fixed; genuine contract ambiguities are resolved
against server source and filed upstream — never matched to a sibling. ADR-0002's contract-
derivation principle, its vendored-pinned-AsyncAPI coverage test, and its deterministic-replay
requirement all stand; only its home and reference clauses are superseded.

## Consequences

- All three SDKs are now governed identically: vendor from the contract, never from a sibling.
- The corpus is re-pinned here on each contract version bump (e.g. AsyncAPI v1.4.1), same as the
  AsyncAPI copy.
- The "corrections owed back to sukko-py" framing in code comments becomes "drift filed upstream
  against the contract corpus"; no cross-SDK reference relationship remains.

## Alternatives rejected

- **Keep ADR-0002 as written** — makes sukko-go/sukko-py vendor from a sibling, the exact rule
  their ADRs forbid.
- **This SDK stays the reference** — enshrines one SDK's current behavior as the contract; the
  contract is the authority.
