import type { Message } from "@sukko/sdk";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
	type Fixture,
	disconnectAll,
	loadFixture,
	makeClient,
	once,
	waitForState,
	withTimeout,
} from "./support";

let fx: Fixture;
beforeAll(() => {
	fx = loadFixture();
});
afterEach(disconnectAll);

// Proves the gateway accepts API-key auth on the WebSocket path (not just JWTs): a
// key-authenticated subscriber connects, subscribes, and receives a published message.
test("API-key auth: a key-authed subscriber receives a published message", async () => {
	const channel = "demo.e2e-apikey";

	const subscriber = makeClient({ url: fx.wsUrl, apiKey: fx.apiKey });
	const delivered = once(subscriber, "message");
	const subscribed = once(subscriber, "subscriptionAck");
	subscriber.connect();
	subscriber.subscribe([channel]);
	await withTimeout(subscribed, 15_000, "subscriptionAck (api-key auth)");

	const publisher = makeClient({ url: fx.wsUrl, token: fx.token });
	const connected = waitForState(publisher, "connected");
	publisher.connect();
	await withTimeout(connected, 15_000, "publisher connected");

	const payload = { via: "api-key", n: 7 };
	publisher.publish(channel, payload);

	const msg = (await withTimeout(delivered, 15_000, "message delivery")) as Message;
	expect(msg.channel).toBe(channel);
	expect(msg.data).toMatchObject(payload);
});
