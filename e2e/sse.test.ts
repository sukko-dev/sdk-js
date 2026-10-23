import type { Message } from "@sukko/sdk";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
	type Fixture,
	disconnectAll,
	httpBase,
	loadFixture,
	makeClient,
	makeSseClient,
	once,
	waitForState,
	withTimeout,
} from "./support";

// SSE transport is Pro-gated (features.go SSETransport:Pro), so this runs only against a
// Pro+ stack — the source-built SDK grid cell. It proves the SDK's SSE CLIENT works end to
// end: subscribe over the receive-only SSE stream and receive a message published over WS.
let fx: Fixture;
beforeAll(() => {
	fx = loadFixture();
});
afterEach(disconnectAll);

test("SSE subscribe→receive against a live Pro gateway", async () => {
	// Subscriber over SSE: subscribe() opens the receive-only stream (no explicit connect()).
	// Register the message handler and the connected-state wait BEFORE publishing, so there
	// is no publish-before-subscribe race.
	const subscriber = makeSseClient({
		url: httpBase(fx.wsUrl),
		channels: [fx.channel],
		token: fx.token,
	});
	const delivered = once(subscriber, "message");
	const streamOpen = waitForState(subscriber, "connected");
	subscriber.subscribe([fx.channel]); // opens the stream with the connect-time channel set
	await withTimeout(streamOpen, 15_000, "SSE stream connected");

	// Publisher over WS — SSE is receive-only. Publish once the WS transport is open (a WS
	// publish is dropped, not buffered, before "connected").
	const publisher = makeClient({ url: fx.wsUrl, token: fx.token });
	const connected = waitForState(publisher, "connected");
	publisher.connect();
	await withTimeout(connected, 15_000, "publisher connected");

	const payload = { hello: "sdk-sse", n: 7 };
	publisher.publish(fx.channel, payload);

	const msg = (await withTimeout(delivered, 30_000, "SSE message delivery")) as Message;
	expect(msg.channel).toBe(fx.channel);
	expect(msg.data).toMatchObject(payload);
});
