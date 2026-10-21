---
"@sukko/sdk": patch
---

Align the WS error-code models exactly with the platform AsyncAPI contract and gate it in CI (ADR-0040). Error-code sets are now runtime consts checked per message type against the vendored, checksum-pinned contract. Two contract-drift fixes change exported types: `SubscribeError.code` now includes `subscribe_limit_exceeded` (the contract declares it), and `HistoryError.code` drops `history_time_range_not_supported` and `not_available` (neither is in the contract's `history_error` enum).
