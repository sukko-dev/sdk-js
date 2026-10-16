# @sukko/websocket

> Browser WebSocket transport for the Sukko SDK.

The browser transport for [`@sukko/sdk`](https://www.npmjs.com/package/@sukko/sdk),
built on the native `WebSocket`. Construct it and hand it to `SukkoClient`.

## Install

```bash
npm i @sukko/sdk @sukko/websocket
```

## Usage

```ts
import { SukkoClient } from "@sukko/sdk";
import { WebSocketTransport } from "@sukko/websocket";

const client = new SukkoClient({
  transport: new WebSocketTransport({ url: "wss://your-server.com/ws" }),
  token: "your-jwt-token",
});
```

## Documentation

- **Guides & API reference:** https://docs.sukko.dev
- **All packages & examples:** https://github.com/sukko-dev/sdk-js

## License

MIT
