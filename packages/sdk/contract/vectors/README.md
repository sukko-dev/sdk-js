# Parity vectors (canonical home)

Language-neutral scenario fixtures (NFR-007). Both SDKs replay the **same** JSON through their pure
state machines and must produce identical canonical action sequences — this is how cross-SDK parity
(SC-007) is *measured* rather than asserted in prose. This repo is the **canonical** home; `sukko-py`
vendors a checksummed copy when it adopts the corrected behaviour (the five owed reference fixes).

## Schema

```jsonc
{
  "name": "recovery/direct-degrade",     // <machine>/<case>
  "machine": "recovery",                  // "recovery" | "auth" | "subscriptions"
  "inputs": [                             // ordered; each is one of:
    { "event": "connected", "clientId": "c1" },     // a named event + canonical payload keys
    { "event": "server", "type": "reconnect_error", "data": { "code": "not_available" } },
    { "advance": 10000 }                             // virtual-time advance in ms (timing-gated paths)
  ],
  "expect": [                             // ordered canonical actions (snake_case tag + sorted keys):
    { "action": "send_reconnect", "last_pos": {} },
    { "action": "emit_possible_gap", "channel": "acme.orders" }
  ]
}
```

- **Canonical encoding**: `action` tags and payload keys are `snake_case`; object keys compared
  order-insensitively, action **list** compared order-sensitively.
- **`advance`** events make timing-gated recovery/auth scenarios expressible without real time.

## Status

Harness + schema only (`tests/_vectors.ts`, self-tested by `tests/vectors.test.ts`). Real
`recovery/*.json` and `auth/*.json` fixtures are added with their machines (Phases 3–4) and asserted
by `tests/recovery.test.ts` / `tests/auth.test.ts` / the full parity run.
