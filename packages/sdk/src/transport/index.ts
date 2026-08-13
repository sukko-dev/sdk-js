// Transport module barrel. Importers use `./transport`; concrete transports live in sibling files
// (`websocket.ts` (WHATWG), `sse.ts`) and are added in later phases.
export type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "./base";
