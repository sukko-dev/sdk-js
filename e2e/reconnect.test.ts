import type { Message } from "@sukko/sdk";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
	type Fixture,
	bounceGateway,
	delay,
	disconnectAll,
	loadFixture,
	makeClient,
	once,
	waitForReconnect,
	waitUntil,
	withTimeout,
} from "./support";

let fx: Fixture;
beforeAll(() => {
	fx = loadFixture();
});
afterEach(disconnectAll);

// Bounces the gateway mid-session: the client must reconnect (reconnecting → connected) and
// resume delivery — the SDK restores its subscriptions on reconnect, so a post-bounce publish
// still reaches the subscriber.
test("reconnects and resumes delivery after the gateway drops", async (ctx) => {
	// This test bounces the gateway *container*, so it needs the compose project name to target
	// it (see bounceGateway). Both the SDK's own run.sh and the sukko grid cell provide
	// composeProject; the guard skips loudly for any ad-hoc fixture that omits it, rather than
	// `docker restart`ing a container named "undefined-ws-gateway-1". Mirrors sse.test.ts's isPro gate.
	const { composeProject } = fx;
	if (!composeProject) {
		// ctx.skip() resolves to vitest's `(note?): never` overload, which narrows composeProject
		// to string below; the note makes the grid skip self-explaining in the vitest output.
		ctx.skip(
			"fixture has no composeProject — the reconnect test needs docker to bounce the gateway",
		);
		return;
	}

	// Fixture-derived channel; single-segment suffix stays under the fixture's wildcard rules
	// (see api-key.test.ts).
	const channel = `${fx.channel}-reconnect`;

	const subscriber = makeClient({ url: fx.wsUrl, token: fx.token });
	let subAcks = 0;
	subscriber.on("subscriptionAck", () => {
		subAcks += 1;
	});
	const reconnected = waitForReconnect(subscriber); // attach before the disruption
	subscriber.connect();
	subscriber.subscribe([channel]);
	await waitUntil(() => subAcks >= 1, 15_000, "initial subscriptionAck");

	// Drop every connection by restarting the gateway; the client must come back.
	bounceGateway(composeProject);
	await withTimeout(reconnected, 45_000, "reconnect (reconnecting→connected)");

	// Delivery must resume. Retry the publish until one lands, so the assertion does not race
	// the subscription restore that follows reconnect (re-subscribe or resume).
	const publisher = makeClient({ url: fx.wsUrl, token: fx.token });
	const payload = { via: "post-reconnect", n: 5 };
	const msg = await publishUntilDelivered(
		subscriber,
		() => publisher.restPublish(channel, payload),
		25_000,
	);
	expect(msg.channel).toBe(channel);
	expect(msg.data).toMatchObject(payload);
}, 90_000); // gateway restart + reconnect backoff + delivery retry exceed the default timeout

// publishUntilDelivered publishes repeatedly until the subscriber delivers a message or the
// deadline passes — tolerant of the brief window after reconnect before the subscription is
// fully restored.
async function publishUntilDelivered(
	subscriber: ReturnType<typeof makeClient>,
	publish: () => Promise<unknown>,
	deadlineMs: number,
): Promise<Message> {
	const start = Date.now();
	while (Date.now() - start < deadlineMs) {
		const delivered = once(subscriber, "message");
		await publish();
		const msg = await Promise.race([delivered, delay(3_000).then(() => null)]);
		if (msg) return msg as Message;
	}
	throw new Error("no delivery after reconnect within deadline");
}
