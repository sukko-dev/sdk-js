#!/usr/bin/env bash
# e2e/run.sh — ADR-0040 Tier2: drive the real Sukko JS SDK against the LATEST RELEASED
# platform. It boots the published GHCR images with the committed prod-signed Community
# license, provisions a client fixture via the `sukko` CLI, and runs the live suite.
#
# Why the CLI: the gateway only accepts client JWTs signed by a registered tenant key
# (ES256/EdDSA — never HS256), so the fixture must register a key and mint a matching
# token. The `sukko` CLI does exactly that (tenant is the auto-provisioned `demo`).
#
# Requirements: docker, go (to build the CLI), bun. Provide the CLI checkout via SUKKO_CLI_DIR,
# or place it at ../cli / .sources/cli.
set -euo pipefail
cd "$(dirname "$0")/.." # repo root

# Backend cell, via SUKKO_E2E_BACKEND: "direct" (default — the Community-direct suite) or
# "kafka" (the gap→replay recovery cell). Kafka is ADR-0009 ungated, so it still runs on the
# released images + the committed Community key — only the message backend changes.
BACKEND="${SUKKO_E2E_BACKEND:-direct}"

# Committed prod-signed Community license — NOT a secret (the free tier unlocks nothing
# gated). It verifies against the production public key embedded in the published images;
# source of truth is the sukko platform's taskfiles/e2e.yml. NEVER commit a Pro/Enterprise key.
COMMUNITY_LICENSE_KEY="eyJlZGl0aW9uIjoiY29tbXVuaXR5Iiwib3JnIjoiS2x1cnZpbyIsImV4cCI6MjEwODExMjcyNSwiaWF0IjoxNzkyNDkzNTI2LCJsaW1pdHMiOnsiZWRpdGlvbiI6ImNvbW11bml0eSIsIm1heF90ZW5hbnRzIjozLCJtYXhfdG90YWxfY29ubmVjdGlvbnMiOjUwMCwibWF4X3NoYXJkcyI6MSwibWF4X3RvcGljc19wZXJfdGVuYW50IjoxMCwibWF4X3JvdXRpbmdfcnVsZXNfcGVyX3RlbmFudCI6MTB9fQ.e0nWF3QBfUHubE8_KvGmIfAV0jGT_ZR0hyt0qDKiMcDvNfeucuD9kuGTSey2d1wIR3o_5XP5BZWKwpenHwTQfA"

# --- 1. resolve + build the sukko CLI (fixture tool) -----------------------------------
SUKKO_CLI_DIR="${SUKKO_CLI_DIR:-}"
if [ -z "$SUKKO_CLI_DIR" ]; then
  for cand in ../cli .sources/cli; do
    if [ -f "$cand/go.mod" ]; then SUKKO_CLI_DIR="$(cd "$cand" && pwd)"; break; fi
  done
fi
if [ -z "$SUKKO_CLI_DIR" ] || [ ! -f "$SUKKO_CLI_DIR/go.mod" ]; then
  echo "ERROR: sukko CLI checkout not found — set SUKKO_CLI_DIR, or place it at ../cli or .sources/cli" >&2
  exit 1
fi
echo "==> building sukko CLI from $SUKKO_CLI_DIR"
BIN_DIR="$(mktemp -d)"
SUKKO="$BIN_DIR/sukko"
( cd "$SUKKO_CLI_DIR" && go build -o "$SUKKO" . )

# --- 2. boot the latest released Community-direct stack --------------------------------
WORK="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="sukko-sdk-e2e-$$"
cleanup() { ( cd "$WORK" && "$SUKKO" down -v >/dev/null 2>&1 || true ); }
trap cleanup EXIT
echo "==> booting the latest released stack (published GHCR images + committed Community key)"
(
  cd "$WORK"
  if [ "$BACKEND" = kafka ]; then
    # init prompts for the message backend then observability; answer kafka + no.
    printf 'kafka\nno\n' | "$SUKKO" init
  else
    "$SUKKO" init --defaults
  fi
  "$SUKKO" license set "$COMMUNITY_LICENSE_KEY"
  "$SUKKO" up --pull # pull the latest published images, not a source build
)

# --- 3. fixture: register an ES256 key for the demo tenant + mint a client JWT ---------
echo "==> provisioning client fixture (demo tenant: ES256 key + client token)"
( cd "$WORK" && "$SUKKO" keys create --generate --tenant demo )
TOKEN="$(cd "$WORK" && "$SUKKO" token generate --tenant demo --sub e2e-client 2>/dev/null | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | head -1)"
if [ -z "$TOKEN" ]; then
  echo "ERROR: could not mint a client token" >&2
  exit 1
fi
# An API key (its full value is returned only on creation) for the api-key auth test.
APIKEY="$(cd "$WORK" && "$SUKKO" api-keys create --tenant demo --name e2e-sdk -o json 2>/dev/null | grep -oE '"key_id": *"[^"]+"' | head -1 | sed -E 's/.*"key_id": *"([^"]+)".*/\1/')"
if [ -z "$APIKEY" ]; then
  echo "ERROR: could not mint an api key" >&2
  exit 1
fi

cat > e2e/.fixture.json <<EOF
{"wsUrl":"ws://localhost:13000/ws","token":"$TOKEN","apiKey":"$APIKEY","channel":"demo.e2e","composeProject":"$COMPOSE_PROJECT_NAME"}
EOF

# --- 4. build the SDK packages the suite imports, then run it --------------------------
echo "==> building SDK packages"
bun run --filter '@sukko/sdk' --filter '@sukko/websocket-node' build >/dev/null
echo "==> running the live e2e suite ($BACKEND)"
# NOT exec: the EXIT trap (stack teardown) must still fire when the suite exits, pass or fail.
if [ "$BACKEND" = kafka ]; then
  ( cd e2e/kafka && bunx vitest run "$@" ) # the recovery cell, scoped to its own config
else
  bun run --filter '@sukko/e2e' test "$@"
fi
