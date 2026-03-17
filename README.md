# Sukko SDK

TypeScript SDK for the [Sukko](https://github.com/klurvio/sukko) real-time platform.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@sukko/sdk`](packages/sdk) | Framework-agnostic, transport-agnostic client | [![npm](https://img.shields.io/npm/v/@sukko/sdk)](https://www.npmjs.com/package/@sukko/sdk) |
| [`@sukko/websocket`](packages/websocket) | WebSocket transport adapter | [![npm](https://img.shields.io/npm/v/@sukko/websocket)](https://www.npmjs.com/package/@sukko/websocket) |
| [`@sukko/react`](packages/react) | React hooks & provider | [![npm](https://img.shields.io/npm/v/@sukko/react)](https://www.npmjs.com/package/@sukko/react) |
| [`@sukko/vue`](packages/vue) | Vue 3 composables & provider | [![npm](https://img.shields.io/npm/v/@sukko/vue)](https://www.npmjs.com/package/@sukko/vue) |
| [`@sukko/svelte`](packages/svelte) | Svelte stores & context | [![npm](https://img.shields.io/npm/v/@sukko/svelte)](https://www.npmjs.com/package/@sukko/svelte) |

## Quick Start

### Vanilla TypeScript

```ts
import { SukkoClient } from "@sukko/sdk";
import { WebSocketTransport } from "@sukko/websocket";

const transport = new WebSocketTransport({ url: "wss://your-server.com/ws" });

const client = new SukkoClient({
  transport,
  token: "your-jwt-token",
});

client.on("message", (msg) => {
  console.log(msg.channel, msg.data);
});

client.subscribe(["acme.general.chat"]);
```

### React

```tsx
import { SukkoProvider, useSubscription, useConnectionState } from "@sukko/react";
import { WebSocketTransport } from "@sukko/websocket";

const transport = new WebSocketTransport({ url: "wss://your-server.com/ws" });

function App() {
  return (
    <SukkoProvider options={{ transport, token }}>
      <ChatRoom />
    </SukkoProvider>
  );
}

function ChatRoom() {
  const { state } = useConnectionState();
  const { data } = useSubscription<ChatMessage>({
    channels: ["acme.general.chat"],
  });

  return (
    <div>
      <p>Status: {state}</p>
      <p>Latest: {data?.text}</p>
    </div>
  );
}
```

### Vue

```vue
<script setup lang="ts">
import { useSubscription, useConnectionState } from "@sukko/vue";

const { state } = useConnectionState();
const { data } = useSubscription<ChatMessage>({
  channels: ["acme.general.chat"],
});
</script>

<template>
  <p>Status: {{ state }}</p>
  <p>Latest: {{ data?.text }}</p>
</template>
```

Wrap your app with `SukkoProvider` or use the Vue plugin:

```ts
import { createApp } from "vue";
import { createSukkoPlugin } from "@sukko/vue";
import { WebSocketTransport } from "@sukko/websocket";

createApp(App)
  .use(createSukkoPlugin({
    transport: new WebSocketTransport({ url: "wss://your-server.com/ws" }),
    token: "your-jwt-token",
  }))
  .mount("#app");
```

### Svelte

```svelte
<script lang="ts">
import { createSubscription, createConnectionState } from "@sukko/svelte";

const connection = createConnectionState();
const subscription = createSubscription<ChatMessage>({
  channels: ["acme.general.chat"],
});
</script>

<p>Status: {$connection.state}</p>
<p>Latest: {$subscription.data?.text}</p>
```

Set the client context in your root component:

```svelte
<script lang="ts">
import { SukkoClient } from "@sukko/sdk";
import { setSukkoClient } from "@sukko/svelte";
import { WebSocketTransport } from "@sukko/websocket";

const client = new SukkoClient({
  transport: new WebSocketTransport({ url: "wss://your-server.com/ws" }),
  token: "your-jwt-token",
});

setSukkoClient(client);
</script>
```

## Features

- **Transport-agnostic core** — `@sukko/sdk` has no transport dependency; use WebSocket, SSE, Web Push, or your own adapter
- **WebSocket transport** — `@sukko/websocket` wraps the browser/Node WebSocket API
- **React bindings** — hooks with `useSyncExternalStore` for tear-free renders
- **Vue bindings** — composables with `provide`/`inject` and reactive refs
- **Svelte bindings** — readable stores with Svelte context API
- **Full protocol support** — subscribe, unsubscribe, publish, heartbeat, reconnect with replay
- **Automatic reconnection** — exponential backoff with jitter, then indefinite retry
- **Reference-counted subscriptions** — multiple components share one subscription
- **Mid-connection auth refresh** — update JWT tokens without disconnecting
- **SSR-safe** — no browser globals accessed during server-side rendering
- **Tree-shakeable** — dual ESM + CJS builds with isolated declarations
- **Type-safe** — full TypeScript types with `isolatedDeclarations` support

## Examples

- [`examples/chat-react`](examples/chat-react) — React chat app demonstrating full Sukko feature set
- [`examples/chat-vue`](examples/chat-vue) — Vue chat app demonstrating full Sukko feature set
- [`examples/chat-svelte`](examples/chat-svelte) — Svelte chat app demonstrating full Sukko feature set

Each example includes: JWT auth, channel subscriptions, publishing, principal-based channels, group-based channels, reconnection with replay, and token refresh. Configure via URL + token input — point at any Sukko deployment.

## Token Generation

Generate test JWT tokens for local development:

```bash
bun run token --sub alice --tenant acme --groups admins,moderators
```

Options: `--sub` (principal), `--tenant` (tenant ID), `--groups` (comma-separated), `--secret` (default: `sukko-dev-secret`), `--exp` (default: `1h`).

## API Reference

### `@sukko/sdk`

#### `Transport` Interface

All transport adapters implement this interface:

```ts
interface Transport {
  open(): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  setToken(token: string): void;
  readonly state: TransportState;  // "closed" | "opening" | "open"
  readonly capabilities: TransportCapabilities;
  on(event, handler): () => void;
  off(event, handler): void;
  removeAllListeners(event?): void;
}
```

#### `SukkoClient`

```ts
new SukkoClient(options: SukkoClientOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `transport` | `Transport` | — | Transport adapter (e.g., `new WebSocketTransport(...)`) |
| `token` | `string` | `""` | JWT token (passed to transport via `setToken()`) |
| `autoConnect` | `boolean` | `true` | Connect on construction |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnectAttempts` | `number` | `5` | Attempts before switching to indefinite mode |
| `reconnectDelayBase` | `number` | `1000` | Base delay (ms) for exponential backoff |
| `reconnectDelayMax` | `number` | `30000` | Max delay (ms) between reconnect attempts |
| `heartbeatInterval` | `number` | `30000` | Heartbeat interval (ms) |
| `heartbeatTimeout` | `number` | `5000` | Pong timeout (ms) |
| `getToken` | `() => Promise<string>` | — | Async token refresh callback |

**Methods**: `connect()`, `disconnect()`, `subscribe(channels)`, `unsubscribe(channels)`, `publish(channel, data)`, `updateToken(token)`, `refreshToken()`, `reconnectWithReplay()`

**Events**: `message`, `stateChange`, `subscriptionAck`, `unsubscriptionAck`, `publishAck`, `publishError`, `reconnectAck`, `reconnectError`, `pong`, `error`, `close`, `reconnecting`

### `@sukko/websocket`

#### `WebSocketTransport`

```ts
new WebSocketTransport(options: WebSocketTransportOptions)
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | — | WebSocket server URL |
| `token` | `string` | `""` | Initial token (overridden by `SukkoClient.setToken()`) |
| `connectionTimeout` | `number` | `10000` | Timeout (ms) for initial connection |
| `WebSocket` | `WebSocketConstructor` | — | Custom WebSocket constructor (for testing or SSR) |

### `@sukko/react`

| Export | Description |
|--------|-------------|
| `SukkoProvider` | Context provider — accepts `client` or `options` |
| `useSukkoClient()` | Access the `SukkoClient` instance |
| `useConnectionState()` | `{ state, isConnected, isReconnecting }` |
| `useSubscription<T>(opts)` | Subscribe to channels, returns `{ data, lastMessage }` |
| `useSukkoEvent(event, handler)` | Listen to any client event |

### `@sukko/vue`

| Export | Description |
|--------|-------------|
| `SukkoProvider` | Vue component provider — accepts `client` or `options` prop |
| `createSukkoPlugin(opts)` | Vue plugin factory for `app.use()` |
| `useSukkoClient()` | Access the `SukkoClient` instance |
| `useConnectionState()` | `{ state, isConnected, isReconnecting }` (reactive refs) |
| `useSubscription<T>(opts)` | Subscribe to channels, returns `{ data, lastMessage, isSubscribed }` |
| `useSukkoEvent(event, handler)` | Listen to any client event |

### `@sukko/svelte`

| Export | Description |
|--------|-------------|
| `setSukkoClient(client)` | Set client in Svelte context |
| `getSukkoClient()` | Get client from context |
| `createConnectionState()` | Readable store: `{ state, isConnected, isReconnecting }` |
| `createSubscription<T>(opts)` | Readable store: `{ data, lastMessage, isSubscribed }` |
| `onSukkoEvent(event, handler)` | Listen to client event with auto-cleanup |

## Development

```bash
bun install          # Install dependencies
bun run build        # Build all packages
bun run test         # Run all tests
bun run lint         # Lint & format check
bun run token ...    # Generate test JWT tokens
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add a changeset: `bunx changeset`
4. Submit a pull request

## License

MIT
