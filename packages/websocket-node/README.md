# @sukko/websocket-node

> Node.js WebSocket transport for the Sukko SDK, with real backpressure.

The Node transport for [`@sukko/sdk`](https://www.npmjs.com/package/@sukko/sdk),
built on the [`ws`](https://www.npmjs.com/package/ws) package with real socket
backpressure. Construct it and hand it to `SukkoClient`.

## Install

```bash
npm i @sukko/sdk @sukko/websocket-node
```

## Usage

```ts
import { SukkoClient } from "@sukko/sdk";
import { WebSocketNodeTransport } from "@sukko/websocket-node";

const client = new SukkoClient({
  transport: new WebSocketNodeTransport({ url: "wss://your-server.com/ws" }),
  token: "your-jwt-token",
});
```

## Documentation

- **Guides & API reference:** https://docs.sukko.dev
- **All packages & examples:** https://github.com/sukko-dev/sdk-js

## License

MIT
