import { readFileSync } from "node:fs";
import { SukkoClient } from "@sukko/sdk";
import type { ConnectionState, Message, SukkoClientEvents } from "@sukko/sdk";
import { WebSocketNodeTransport } from "@sukko/websocket-node";
import { afterEach, beforeAll, expect, test } from "vitest";

// The live stack details are produced by run.sh (boot + provision) and handed over as a
// fixture file, so the test stays pure: connect the real SDK and assert real delivery.
interface Fixture {
	wsUrl: string;
	token: string;
	channel: string;
}

let fx: Fixture;
beforeAll(() => {
	fx = JSON.parse(readFileSync(new URL("./.fixture.json", import.meta.url), "utf8")) as Fixture;
});

const clients: SukkoClient[] = [];
function newClient(): SukkoClient {
	const client = new SukkoClient({
		transport: new WebSocketNodeTransport({ url: fx.wsUrl }),
		token: fx.token,
	});
	clients.push(client);
	return client;
}
afterEach(() => {
	for (const client of clients) client.disconnect();
	clients.length = 0;
});

// once resolves with the first payload of a client event — used to await the server's acks
// instead of sleeping, so there is no publish-before-subscribe race.
function once<E extends keyof SukkoClientEvents>(
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
// transition is never missed. Needed for the publisher: client.publish() over WS is dropped
// (not buffered) unless the transport is already open, so we publish only once "connected".
function waitForState(client: SukkoClient, target: ConnectionState): Promise<void> {
	return new Promise((resolve) => {
		client.on("stateChange", (state: ConnectionState) => {
			if (state === target) resolve();
		});
	});
}
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms),
		),
	]);
}

test("WS pub/sub round-trip against a live released gateway", async () => {
	// Subscriber: connect and subscribe, then wait for the server's subscription ack (which
	// also confirms the connection authenticated) before anything is published.
	const subscriber = newClient();
	const delivered = once(subscriber, "message");
	const subscribed = once(subscriber, "subscriptionAck");
	subscriber.connect();
	subscriber.subscribe([fx.channel]);
	await withTimeout(subscribed, 15_000, "subscriptionAck");

	// Publisher: a separate connection; wait until it is fully connected (publish over WS is
	// dropped unless the transport is open), then publish. The gateway broadcasts to every
	// subscriber of the channel, across connections.
	const publisher = newClient();
	const connected = waitForState(publisher, "connected");
	publisher.connect();
	await withTimeout(connected, 15_000, "publisher connected");

	const payload = { hello: "sdk-e2e", n: 42 };
	publisher.publish(fx.channel, payload);

	const msg = (await withTimeout(delivered, 15_000, "message delivery")) as Message;
	expect(msg.channel).toBe(fx.channel);
	expect(msg.data).toMatchObject(payload);
});
