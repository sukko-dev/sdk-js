// Transport module barrel. Importers use `./transport`; the `Transport` interface lives in `base.ts`,
// concrete transports in sibling files (SSE here; the WebSocket adapter ships as `@sukko/websocket`).
export type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "./base";
export { SseTransport } from "./sse";
export type { SseTransportOptions } from "./sse";
