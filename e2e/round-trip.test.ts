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

test("WS pub/sub round-trip against a live released gateway", async () => {
	// Subscriber: connect and subscribe, then wait for the server's subscription ack (which
	// also confirms the connection authenticated) before anything is published.
	const subscriber = makeClient({ url: fx.wsUrl, token: fx.token });
	const delivered = once(subscriber, "message");
	const subscribed = once(subscriber, "subscriptionAck");
	subscriber.connect();
	subscriber.subscribe([fx.channel]);
	await withTimeout(subscribed, 15_000, "subscriptionAck");

	// Publisher: a separate connection; wait until it is fully connected (publish over WS is
	// dropped unless the transport is open), then publish. The gateway broadcasts to every
	// subscriber of the channel, across connections.
	const publisher = makeClient({ url: fx.wsUrl, token: fx.token });
	const connected = waitForState(publisher, "connected");
	publisher.connect();
	await withTimeout(connected, 15_000, "publisher connected");

	const payload = { hello: "sdk-e2e", n: 42 };
	publisher.publish(fx.channel, payload);

	const msg = (await withTimeout(delivered, 15_000, "message delivery")) as Message;
	expect(msg.channel).toBe(fx.channel);
	expect(msg.data).toMatchObject(payload);
});
