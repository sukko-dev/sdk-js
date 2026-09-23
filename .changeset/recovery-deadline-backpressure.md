---
"@sukko/sdk": patch
---

Suspend the recovery detection deadline while the delivery consumer is backpressured. Previously a slow consumer could pause the transport during a replay (or history), stopping recovery frames, so the idle deadline would fire and raise a spurious `RecoveryInterrupted` even though the server was fine. The deadline now detects server silence, not consumer speed — it suspends while stalled and re-arms on resume (platform ADR-0025), matching sukko-go and sukko-py.
