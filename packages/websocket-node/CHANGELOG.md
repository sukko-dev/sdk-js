# @sukko/websocket-node

## 2.0.0

### Minor Changes

- fd94001: Add API-key authentication. A new `apiKey` client option authenticates with an API key (the JWT
  alternative, matching the Go and Python SDKs). Over WebSocket the browser transport sends
  credentials as `?token=`/`?api_key=` query params (browsers cannot set WebSocket request headers)
  and the Node transport sends them as `Authorization: Bearer`/`X-API-Key` headers; SSE and REST use
  those headers. The Node WebSocket transport now sends the JWT as an `Authorization` header instead
  of a `?token=` query param (both are gateway-accepted; headers avoid logging the credential in
  URLs). A JWT always takes precedence over an API key, so `escalate()` continues to upgrade an
  API-key session to a JWT.

### Patch Changes

- Updated dependencies [fd94001]
- Updated dependencies [7b5abbb]
  - @sukko/sdk@2.0.0

## 1.0.0

### Patch Changes

- Updated dependencies [701f34a]
- Updated dependencies [82e1143]
  - @sukko/sdk@1.0.0
