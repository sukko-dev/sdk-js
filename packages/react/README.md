# @sukko/react

> React hooks and provider for the Sukko real-time WebSocket SDK.

Wrap your app in `SukkoProvider` and subscribe with hooks.

## Install

```bash
npm i @sukko/sdk @sukko/react @sukko/websocket
```

## Usage

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

## Documentation

- **Guides & API reference:** https://docs.sukko.dev
- **All packages & examples:** https://github.com/sukko-dev/sdk-js

## License

MIT
