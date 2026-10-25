# @sukko/sdk

## 0.1.2

### Patch Changes

- f741159: Align the WS error-code models exactly with the platform AsyncAPI contract and gate it in CI (ADR-0040). Error-code sets are now runtime consts checked per message type against the vendored, checksum-pinned contract. Two contract-drift fixes change exported types: `SubscribeError.code` now includes `subscribe_limit_exceeded` (the contract declares it), and `HistoryError.code` drops `history_time_range_not_supported` and `not_available` (neither is in the contract's `history_error` enum).

## 0.1.1

### Patch Changes

- 6186100: Version-alignment release: the published Sukko JS SDK packages move to 0.1.1 to line up with the other Sukko SDKs on the 0.1.x line. No functional changes.

## 0.1.0

Initial release.
