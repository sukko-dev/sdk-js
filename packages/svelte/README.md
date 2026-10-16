# @sukko/svelte

> Svelte 5 stores and context for the Sukko real-time WebSocket SDK.

Set the client context in your root component and subscribe with stores.

## Install

```bash
npm i @sukko/sdk @sukko/svelte @sukko/websocket
```

## Usage

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

## Documentation

- **Guides & API reference:** https://docs.sukko.dev
- **All packages & examples:** https://github.com/sukko-dev/sdk-js

## License

MIT
