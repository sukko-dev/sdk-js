# @sukko/vue

> Vue 3 composables and provider for the Sukko real-time WebSocket SDK.

Install the Sukko plugin and subscribe with composables.

## Install

```bash
npm i @sukko/sdk @sukko/vue @sukko/websocket
```

## Usage

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

## Documentation

- **Guides & API reference:** https://docs.sukko.dev
- **All packages & examples:** https://github.com/sukko-dev/sdk-js

## License

MIT
