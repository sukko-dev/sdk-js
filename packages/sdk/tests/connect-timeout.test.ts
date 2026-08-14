// connectTimeoutMs — the per-attempt handshake deadline. If a transport opens but never reaches
// `connected` within the window, the client aborts the stuck attempt and reconnects with backoff.

import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/_clock";
import { SukkoClient } from "../src/client";
import { TypedEventEmitter } from "../src/emitter";
import type { SukkoClientOptions } from "../src/options";
import type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "../src/transport";

/** A transport whose open() reaches `opening` and STALLS — it never emits `open` on its own, so the
 * client's handshake deadline is the only thing that can end the attempt. Capabilities are overridable
 * (default WS-shaped); `emitOpen()` completes the handshake manually. */
class StallingTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
	openCount = 0;
	private readonly caps: TransportCapabilities;

	constructor(caps?: Partial<TransportCapabilities>) {
		super();
		this.caps = {
			canSend: true,
			canSubscribe: true,
			canPublish: true,
			canPauseReceive: false,
			...caps,
		};
	}
	get state(): TransportState {
		return this._state;
	}
	get capabilities(): TransportCapabilities {
		return this.caps;
	}
	get url(): string {
		return "https://gw.example.com";
	}
	setToken(): void {}
	setChannels(): void {}
	send(): void {}
	pause(): void {}
	resume(): void {}
	open(): void {
		if (this._state !== "closed") return;
		this._state = "opening";
		this.openCount++; // stalls here — never emits "open"
	}
	close(): void {
		this._state = "closed";
	}
	emitOpen(): void {
		this._state = "open";
		this.emit("open");
	}
}

function makeClient(
	overrides: Partial<SukkoClientOptions> = {},
	caps?: Partial<TransportCapabilities>,
): { client: SukkoClient; transport: StallingTransport; clock: FakeClock } {
	const clock = new FakeClock();
	const transport = new StallingTransport(caps);
	const client = new SukkoClient({
		transport,
		autoConnect: false,
		reconnect: true,
		token: "t",
		clock,
		connectTimeoutMs: 10000,
		...overrides,
	});
	return { client, transport, clock };
}

describe("connect timeout (handshake deadline)", () => {
	it("aborts a stalled handshake after connectTimeoutMs and reconnects with backoff", async () => {
		const { client, transport, clock } = makeClient();
		const reconnecting = vi.fn();
		client.on("reconnecting", reconnecting);

		client.connect();
		expect(transport.openCount).toBe(1); // opened, now stalled in "opening"

		await clock.advance(10000); // handshake deadline elapses
		expect(reconnecting).toHaveBeenCalled(); // timed out → backoff reconnect, not a silent hang

		await clock.advance(1000); // fire the backoff sleeper (ceiling backoffBaseMs = 1000)
		expect(transport.openCount).toBe(2); // the SAME instance was reopened for the retry
		client.disconnect();
	});

	it("releases the deadline sleeper the moment the handshake completes (witnesses the cancel)", async () => {
		// Receive-only so handleTransportOpen starts no heartbeat/recovery timers — the ONLY pending sleeper
		// is the connect deadline, so `pending` dropping to 0 witnesses the cancel-on-open specifically
		// (an outcome-only assertion can't: the post-await `state==="open"` recheck would suppress a leaked
		// sleeper anyway — one-sided green).
		const { client, transport, clock } = makeClient({}, { canSend: false, canSubscribe: false });
		const states: string[] = [];
		client.on("stateChange", (s) => states.push(s));

		client.subscribe(["acme.a"]); // on a connect-time transport, subscribing drives the open
		expect(clock.pending).toBe(1); // the handshake deadline is armed
		transport.emitOpen(); // handshake completes → connected
		expect(clock.pending).toBe(0); // deadline sleeper cancelled, not merely suppressed later
		expect(client.state).toBe("connected");

		await clock.advance(20000); // well past connectTimeoutMs
		expect(client.state).toBe("connected");
		expect(states).not.toContain("reconnecting");
		expect(transport.openCount).toBe(1);
		client.disconnect();
	});

	it("arms no deadline for an idle connect-time transport with nothing subscribed", async () => {
		const { client, transport, clock } = makeClient({}, { canSend: false, canSubscribe: false });
		const reconnecting = vi.fn();
		client.on("reconnecting", reconnecting);

		client.connect(); // SSE + empty desired → benign no-op, no open(), no deadline armed
		expect(clock.pending).toBe(0);
		expect(transport.openCount).toBe(0);

		await clock.advance(20000); // no armed deadline → nothing fires
		expect(reconnecting).not.toHaveBeenCalled();
		expect(client.state).toBe("disconnected");
	});

	it("goes terminal (disconnected) on a stalled handshake when reconnect is disabled", async () => {
		const { client, transport, clock } = makeClient({ reconnect: false });
		client.connect();
		await clock.advance(10000);
		expect(client.state).toBe("disconnected"); // no reconnect → terminal, not a loop
		expect(transport.openCount).toBe(1);
	});

	it("exhausts reconnectMaxAttempts on repeated stalls and ends in the terminal error state", async () => {
		const { client, clock } = makeClient({ reconnectMaxAttempts: 3 });
		client.connect();
		// Each cycle: the deadline elapses → a backoff reconnect fires → the reopened transport stalls
		// again. After the finite attempts are spent the client gives up (FR-026 — no infinite retry).
		for (let i = 0; i < 5; i++) {
			await clock.advance(10000); // handshake deadline
			await clock.advance(30000); // backoff (generous cap)
		}
		expect(client.state).toBe("error");
	});

	it("cancels the deadline on disconnect() mid-handshake (no late fire)", async () => {
		const { client, transport, clock } = makeClient();
		const reconnecting = vi.fn();
		client.on("reconnecting", reconnecting);

		client.connect();
		client.disconnect(); // tears down the epoch → cancels the connect timer
		await clock.advance(20000);
		expect(reconnecting).not.toHaveBeenCalled();
		expect(client.state).toBe("disconnected");
		expect(transport.openCount).toBe(1);
	});
});
