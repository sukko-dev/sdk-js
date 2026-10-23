import type { Message, ReconnectAck } from "@sukko/sdk";
import { afterEach, beforeAll, expect, test } from "vitest";
import {
	type Fixture,
	disconnectAll,
	loadFixture,
	makeClient,
	once,
	waitForState,
	waitUntil,
	withTimeout,
} from "../support";

let fx: Fixture;
beforeAll(() => {
	fx = loadFixture();
});
afterEach(disconnectAll);

// Gap→replay recovery (kafka backend only — on direct it degrades). Proves no-loss recovery:
// messages published while the subscriber's WebSocket is down are replayed on reconnect. Only
// the WS is dropped (client.disconnect()) — the gateway stays up so REST publishes still land;
// the kafka backend retains them and the SDK's automatic reconnect-replay delivers them.
test("kafka gap→replay: messages published during a disconnect are replayed on reconnect", async () => {
	const channel = "demo.e2e-recovery";
	const received: Message[] = [];
	let replayed = -1;

	const client = makeClient({ url: fx.wsUrl, token: fx.token });
	client.on("message", (m) => received.push(m));
	client.on("reconnectAck", (ack: ReconnectAck) => {
		replayed = ack.messages_replayed;
	});

	const subscribed = once(client, "subscriptionAck");
	client.connect();
	client.subscribe([channel]);
	await withTimeout(subscribed, 15_000, "subscriptionAck");

	// msg1 establishes the replay cursor (its pos) AND proves the kafka backend — a direct
	// backend delivers no pos. First delivery on a fresh topic can be slow, so wait generously.
	const publisher = makeClient({ url: fx.wsUrl, token: fx.token });
	await withTimeout(publisher.restPublish(channel, { seq: 1 }), 20_000, "publish msg1");
	await waitUntil(() => received.some((m) => m.data.seq === 1), 60_000, "msg1 delivery");
	const m1 = received.find((m) => m.data.seq === 1);
	expect(m1?.pos, "msg1 must carry a kafka pos cursor (proves the kafka backend)").toBeDefined();

	// Drop ONLY the WebSocket; the gateway stays up. disconnect() preserves the client_id,
	// channels, and pos cursor the SDK resumes from.
	client.disconnect();

	// Publish while the subscriber is offline — the kafka backend retains these.
	await withTimeout(publisher.restPublish(channel, { seq: 2 }), 20_000, "publish msg2 (offline)");
	await withTimeout(publisher.restPublish(channel, { seq: 3 }), 20_000, "publish msg3 (offline)");

	// Reconnect — the SDK auto-sends reconnect{last_pos} and the server replays the missed
	// messages as plain message frames, then a reconnect_ack.
	const reconnected = waitForState(client, "connected");
	client.connect();
	await withTimeout(reconnected, 20_000, "reconnect");

	await waitUntil(
		() => received.some((m) => m.data.seq === 2) && received.some((m) => m.data.seq === 3),
		20_000,
		"replay of msg2 + msg3",
	);

	// No-loss recovery: exactly msg2 and msg3 were replayed; msg1 (the anchor) is not
	// re-delivered — last_pos is an exclusive cursor.
	expect(replayed, "reconnectAck.messages_replayed").toBe(2);
	expect(received.filter((m) => m.data.seq === 1).length, "anchor msg1 not re-delivered").toBe(1);
}, 120_000);
