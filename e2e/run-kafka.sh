#!/usr/bin/env bash
# e2e/run-kafka.sh — the kafka gap→replay recovery cell. Same released-image harness as
# run.sh (kafka is ADR-0009-ungated, so still Community on the published images — no source
# build, no Pro key), only the message backend differs. Delegates to run.sh.
set -euo pipefail
SUKKO_E2E_BACKEND=kafka exec bash "$(dirname "$0")/run.sh" "$@"
