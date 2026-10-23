import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { SseTransport, SukkoClient } from "@sukko/sdk";
import type { ConnectionState, SukkoClientEvents } from "@sukko/sdk";
import { WebSocketNodeTransport } from "@sukko/websocket-node";

// The live stack details are produced by run.sh (boot + provision) and handed over as a
// fixture file, so the tests stay pure: connect the real SDK and assert real behavior.
export interface Fixture {
	wsUrl: string;
	token: string;
	apiKey: string;
	channel: string;
	composeProject?: string; // compose project name, so tests can bounce a service (WS cells only)
	edition?: string; // the stack's license edition — Pro-gated tests gate on it
}

export function loadFixture(): Fixture {
	return JSON.parse(readFileSync(new URL("./.fixture.json", import.meta.url), "utf8")) as Fixture;
}

// isPro reports whether the live stack is Pro+ — Pro-gated transports (SSE, Web Push) only
// work there, so their tests skip otherwise. The Community nightly leaves edition "community"
// (or unset), so those tests skip; the source-built Pro grid cells set it to pro/enterprise.
export function isPro(fx: Fixture): boolean {
	return fx.edition === "pro" || fx.edition === "enterprise";
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
// makeSseClient builds a client over the receive-only SSE transport (and tracks it for
// disconnectAll). `url` is the gateway's HTTP base — the transport opens `GET {url}/sse`.
// SSE channels are a required, connect-time subscription, so they are passed at
// construction (and auth goes on the transport, which makes the authed GET). SSE cannot
// publish, so a WS client (makeClient) does the publishing in these tests.
export function makeSseClient(opts: {
	url: string;
	channels: string[];
	token?: string;
	apiKey?: string;
}): SukkoClient {
	const client = new SukkoClient({
		transport: new SseTransport({
			url: opts.url,
			channels: opts.channels,
			token: opts.token,
			apiKey: opts.apiKey,
		}),
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

// httpBase turns the fixture's ws(s) URL into the gateway's HTTP(S) base the SSE transport
// needs (ws://host:port/ws → http://host:port), dropping the WebSocket path.
export function httpBase(wsUrl: string): string {
	return wsUrl.replace(/^ws(s?):\/\//, "http$1://").replace(/\/ws\/?$/, "");
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

// waitForReconnect resolves when the client reconnects — a "connected" that follows a
// "reconnecting". Attach it BEFORE the disruption so the cycle is not missed.
export function waitForReconnect(client: SukkoClient): Promise<void> {
	return new Promise((resolve) => {
		let sawReconnecting = false;
		client.on("stateChange", (state: ConnectionState) => {
			if (state === "reconnecting") sawReconnecting = true;
			else if (state === "connected" && sawReconnecting) resolve();
		});
	});
}

// bounceGateway restarts the gateway container, dropping every connection — the real-world
// disruption that exercises the client's reconnect path. The compose project comes from the
// fixture; compose names the container "<project>-ws-gateway-1".
export function bounceGateway(composeProject: string): void {
	execFileSync("docker", ["restart", `${composeProject}-ws-gateway-1`], { stdio: "ignore" });
}

// delay resolves after ms — used to pace publish retries, not to mask a race.
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// waitUntil polls pred() until it is true, rejecting at the deadline.
export function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (pred()) return resolve();
			if (Date.now() - start > ms) return reject(new Error(`timed out waiting for ${what}`));
			setTimeout(tick, 100);
		};
		tick();
	});
}
