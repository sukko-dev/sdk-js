import type { Message } from "@sukko/sdk";
import { afterEach, beforeAll, expect, test } from "vitest";
import { type Fixture, disconnectAll, loadFixture, makeClient, once, withTimeout } from "./support";

let fx: Fixture;
beforeAll(() => {
	fx = loadFixture();
});
afterEach(disconnectAll);

// restPublish is the awaitable HTTP publish path — it needs no live WebSocket to send. It
// must resolve (the gateway accepted the publish) and the message must reach a WS subscriber.
test("REST publish: an awaitable HTTP publish is delivered to a WS subscriber", async () => {
	const channel = "demo.e2e-rest";

	const subscriber = makeClient({ url: fx.wsUrl, token: fx.token });
	const delivered = once(subscriber, "message");
	const subscribed = once(subscriber, "subscriptionAck");
	subscriber.connect();
	subscriber.subscribe([channel]);
	await withTimeout(subscribed, 15_000, "subscriptionAck");

	// A second client publishes over REST without ever opening its WebSocket (the HTTP origin
	// is derived from the transport URL).
	const publisher = makeClient({ url: fx.wsUrl, token: fx.token });
	const payload = { via: "rest", n: 99 };
	await withTimeout(publisher.restPublish(channel, payload), 15_000, "restPublish ack");

	const msg = (await withTimeout(delivered, 15_000, "message delivery")) as Message;
	expect(msg.channel).toBe(channel);
	expect(msg.data).toMatchObject(payload);
});
