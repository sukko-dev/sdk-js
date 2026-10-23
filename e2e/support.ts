import { readFileSync } from "node:fs";
import { SukkoClient } from "@sukko/sdk";
import type { ConnectionState, SukkoClientEvents } from "@sukko/sdk";
import { WebSocketNodeTransport } from "@sukko/websocket-node";

// The live stack details are produced by run.sh (boot + provision) and handed over as a
// fixture file, so the tests stay pure: connect the real SDK and assert real behavior.
export interface Fixture {
	wsUrl: string;
	token: string;
	apiKey: string;
	channel: string;
}

export function loadFixture(): Fixture {
	return JSON.parse(readFileSync(new URL("./.fixture.json", import.meta.url), "utf8")) as Fixture;
}

// makeClient builds a client over the Node WebSocket transport and tracks it so a test's
// afterEach can disconnectAll(). Pass `token` for JWT auth or `apiKey` for API-key auth.
const tracked: SukkoClient[] = [];
export function makeClient(opts: { url: string; token?: string; apiKey?: string }): SukkoClient {
	const client = new SukkoClient({
		transport: new WebSocketNodeTransport({ url: opts.url }),
		token: opts.token,
		apiKey: opts.apiKey,
	});
	tracked.push(client);
	return client;
}
export function disconnectAll(): void {
	for (const client of tracked) client.disconnect();
	tracked.length = 0;
}

// once resolves with the first payload of a client event — used to await the server's acks
// instead of sleeping, so there is no publish-before-subscribe race.
export function once<E extends keyof SukkoClientEvents>(
	client: SukkoClient,
	event: E,
): Promise<Parameters<SukkoClientEvents[E]>[0]> {
	return new Promise((resolve) => {
		const handler = ((arg: Parameters<SukkoClientEvents[E]>[0]) =>
			resolve(arg)) as SukkoClientEvents[E];
		client.on(event, handler);
	});
}

// waitForState resolves once the client reaches `target`. Attach it BEFORE connect() so the
// transition is never missed — needed before a WS publish(), which is dropped (not buffered)
// unless the transport is already open.
export function waitForState(client: SukkoClient, target: ConnectionState): Promise<void> {
	return new Promise((resolve) => {
		client.on("stateChange", (state: ConnectionState) => {
			if (state === target) resolve();
		});
	});
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
		),
	]);
}
