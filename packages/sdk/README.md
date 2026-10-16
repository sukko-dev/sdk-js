# @sukko/sdk

> TypeScript client SDK for the Sukko real-time WebSocket platform.

The core client. Pair it with a transport — `@sukko/websocket` (browsers) or
`@sukko/websocket-node` (Node) — and subscribe to channels.

## Install

```bash
npm i @sukko/sdk @sukko/websocket
```

## Usage

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

## Documentation

- **Guides & API reference:** https://docs.sukko.dev
- **All packages & examples:** https://github.com/sukko-dev/sdk-js

## License

MIT
