// @vitest-environment node
// Pinned to node so the "no DOM globals" assertion stays meaningful even if the workspace default ever
// switches to jsdom.
// T042 — NFR-002 (import/module-init safety in a non-browser runtime) + FR-023 (the transport instance
// is fixed for the client's lifetime — no automatic WS↔SSE fallback, no swap API). The core must import
// and instantiate under Node with no DOM globals; browser-only capabilities are gated at call time.

import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/_clock";
import { TypedEventEmitter } from "../src/emitter";
import type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "../src/transport";

/** A minimal receive-only transport with a controllable open/close, for the FR-023 reuse assertion. */
class CountingTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
	openCount = 0;
	get state(): TransportState {
		return this._state;
	}
	get capabilities(): TransportCapabilities {
		return { canSend: false, canSubscribe: false, canPublish: false, canPauseReceive: false };
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
		this.openCount++;
		queueMicrotask(() => {
			if (this._state === "opening") {
				this._state = "open";
				this.emit("open");
			}
		});
	}
	close(): void {
		this._state = "closed";
	}
	simulateClose(code: number): void {
		this._state = "closed";
		this.emit("close", code, "");
	}
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("import safety (NFR-002)", () => {
	it("runs in a non-browser runtime — no DOM globals at module scope", () => {
		expect(typeof window).toBe("undefined");
		expect(typeof document).toBe("undefined");
	});

	it("imports the barrel and instantiates the core with no module-init throw", async () => {
		const mod = await import("../src/index");
		expect(typeof mod.SukkoClient).toBe("function");

		const transport = new CountingTransport();
		expect(() => new mod.SukkoClient({ transport, autoConnect: false, token: "t" })).not.toThrow();
		// The SSE transport module is likewise import-safe (fetch/AbortController are Node globals).
		expect(
			() => new mod.SseTransport({ url: "https://gw.example.com", channels: ["a"] }),
		).not.toThrow();
	});

	it("gates browser-only enableWebPush at call time (rejects under Node, does not throw at import)", async () => {
		const { SukkoClient, ConfigurationError } = await import("../src/index");
		const transport = new CountingTransport(); // exposes a url → the REST/push client is available
		const client = new SukkoClient({ transport, autoConnect: false, token: "t" });
		await expect(client.push.enableWebPush({ channels: ["a"] })).rejects.toBeInstanceOf(
			ConfigurationError,
		);
	});
});

describe("transport is fixed for the client's lifetime (FR-023)", () => {
	it("exposes no API to swap the transport", async () => {
		const { SukkoClient } = await import("../src/index");
		const client = new SukkoClient({ transport: new CountingTransport(), autoConnect: false });
		const proto = Object.getPrototypeOf(client) as Record<string, unknown>;
		// No swap method on the public surface — the transport is injected once at construction and the
		// reuse test below proves it is never replaced. (The `transport` field is TS-`private`; TS privates
		// are compile-time only, so it is deliberately NOT probed at runtime.)
		expect(proto.setTransport).toBeUndefined();
		expect(proto.useTransport).toBeUndefined();
	});

	it("reuses the same transport instance across a reconnect — never allocates a new one", async () => {
		const { SukkoClient } = await import("../src/index");
		const clock = new FakeClock();
		const transport = new CountingTransport();
		const client = new SukkoClient({
			transport,
			autoConnect: false,
			reconnect: true,
			token: "t",
			clock,
			fetch: async () => new Response(null, { status: 202 }),
		});
		client.subscribe(["acme.a"]); // opens the (only) transport instance
		await flush();
		expect(transport.openCount).toBe(1);

		transport.simulateClose(1006); // transient drop → backoff reconnect
		await clock.advance(30000);
		await flush();
		// The SAME instance was reopened (openCount grew on it) — the client never constructs a transport,
		// so there is no path by which a second instance (or a different class) could appear.
		expect(transport.openCount).toBe(2);
		expect(client.state).toBe("connected");
		client.disconnect();
	});
});
