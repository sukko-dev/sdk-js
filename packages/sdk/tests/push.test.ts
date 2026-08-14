import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/_clock";
import { clearSecrets } from "../src/_redact";
import { ConfigurationError, EditionRequiredError, ProtocolError } from "../src/errors";
import { type FetchLike, HttpApi } from "../src/http";
import { PushClient } from "../src/push";

afterEach(() => clearSecrets());

function makePush(fetchImpl: FetchLike): PushClient {
	const http = new HttpApi({
		baseUrl: "https://gw.example.com",
		token: () => "jwt",
		fetch: fetchImpl,
		clock: new FakeClock(),
	});
	return new PushClient(http);
}

describe("PushClient — subscribe", () => {
	it("subscribes a web device, maps keys to snake_case, returns the deviceId string", async () => {
		let url = "";
		let body: unknown;
		const push = makePush(async (u, init) => {
			url = u;
			body = init?.body;
			return new Response(JSON.stringify({ device_id: 12345 }), { status: 201 });
		});

		const id = await push.subscribe({
			platform: "web",
			channels: ["acme.general"],
			endpoint: "https://fcm.googleapis.com/x",
			p256dhKey: "BNcR",
			authSecret: "tBH",
		});

		expect(id).toBe("12345");
		expect(url).toBe("https://gw.example.com/api/v1/push/subscribe");
		expect(JSON.parse(body as string)).toEqual({
			platform: "web",
			channels: ["acme.general"],
			endpoint: "https://fcm.googleapis.com/x",
			p256dh_key: "BNcR", // camelCase → snake_case on the wire
			auth_secret: "tBH",
		});
	});

	it("subscribes an android device with a token", async () => {
		let body: unknown;
		const push = makePush(async (_u, init) => {
			body = init?.body;
			return new Response(JSON.stringify({ device_id: 99 }), { status: 201 });
		});
		await push.subscribe({ platform: "android", channels: ["acme.x"], token: "fcm-tok" });
		expect(JSON.parse(body as string)).toEqual({
			platform: "android",
			channels: ["acme.x"],
			token: "fcm-tok",
		});
	});

	it("preserves int64 precision in the returned deviceId (beyond 2^53)", async () => {
		const big = "9223372036854775807"; // max int64 — unrepresentable exactly as a JS number
		const push = makePush(async () => new Response(`{"device_id": ${big}}`, { status: 201 }));
		const id = await push.subscribe({ platform: "ios", channels: ["a"], token: "t" });
		expect(id).toBe(big); // exact string, not the JSON.parse-rounded 9223372036854775808
	});

	it("validates per-platform fields locally (no request on a bad call)", async () => {
		let called = false;
		const push = makePush(async () => {
			called = true;
			return new Response("{}", { status: 201 });
		});
		await expect(push.subscribe({ platform: "web", channels: ["a"] })).rejects.toBeInstanceOf(
			ConfigurationError,
		);
		await expect(push.subscribe({ platform: "android", channels: ["a"] })).rejects.toBeInstanceOf(
			ConfigurationError,
		);
		await expect(push.subscribe({ platform: "ios", channels: ["a"] })).rejects.toBeInstanceOf(
			ConfigurationError,
		);
		expect(called).toBe(false);
	});

	it("registers subscriber secrets so a failing subscribe masks them (§IX)", async () => {
		const p256dh = "p256dhSECRETvalue12345";
		const authSecret = "authSECRETvalue67890";
		// A non-JSON-shaped leak: only the per-request registerSecret can mask it.
		const push = makePush(async () => {
			throw new Error(`push failed near ${p256dh} / ${authSecret}`);
		});
		const err = (await push
			.subscribe({
				platform: "web",
				channels: ["a"],
				endpoint: "https://ep",
				p256dhKey: p256dh,
				authSecret,
			})
			.catch((e: unknown) => e)) as Error;
		expect(err.message).not.toContain(p256dh);
		expect(err.message).not.toContain(authSecret);
	});

	it("throws ProtocolError when the response carries no device_id", async () => {
		const push = makePush(async () => new Response("{}", { status: 201 }));
		await expect(
			push.subscribe({ platform: "android", channels: ["a"], token: "t" }),
		).rejects.toBeInstanceOf(ProtocolError);
	});

	it("surfaces EditionRequiredError on a 403 (Enterprise gate) even with an empty body", async () => {
		const push = makePush(async () => new Response("", { status: 403 }));
		await expect(
			push.subscribe({ platform: "android", channels: ["a"], token: "t" }),
		).rejects.toBeInstanceOf(EditionRequiredError);
	});
});

describe("PushClient — unsubscribe", () => {
	it("sends device_id as an UNQUOTED int64 literal (custom serialization)", async () => {
		let method = "";
		let body: unknown;
		const push = makePush(async (_u, init) => {
			method = init?.method ?? "";
			body = init?.body;
			return new Response(null, { status: 204 });
		});
		await push.unsubscribe("9223372036854775807");
		expect(method).toBe("DELETE");
		expect(body).toBe('{"device_id":9223372036854775807}'); // unquoted, exact — not "…" and not rounded
	});

	it("rejects an injecting, non-canonical, or out-of-range deviceId locally (no request)", async () => {
		let called = false;
		const push = makePush(async () => {
			called = true;
			return new Response(null, { status: 204 });
		});
		const bad = [
			'1,"x":2', // injection attempt
			"not-a-number", // non-digit
			"", // empty
			"0123", // leading zero → would emit malformed JSON on the wire
			"00", // leading zero / zero
			"0", // not positive
			"9999999999999999999", // 19 digits but > int64 max
			"99999999999999999999", // 20 digits (past the pre-filter)
		];
		for (const id of bad) {
			await expect(push.unsubscribe(id)).rejects.toBeInstanceOf(ConfigurationError);
		}
		expect(called).toBe(false);
	});
});

describe("PushClient — enableWebPush", () => {
	// `globalThis.navigator` is a read-only getter in Node — override the browser globals via vi.
	afterEach(() => vi.unstubAllGlobals());

	function stubBrowser(subscribe: (opts: unknown) => Promise<unknown>): void {
		vi.stubGlobal("PushManager", class {});
		vi.stubGlobal("navigator", {
			serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe } }) },
		});
	}

	it("throws ConfigurationError outside a Web Push-capable browser (Node)", async () => {
		const push = makePush(
			async () => new Response(JSON.stringify({ device_id: 1 }), { status: 201 }),
		);
		await expect(push.enableWebPush({ channels: ["a"] })).rejects.toBeInstanceOf(
			ConfigurationError,
		);
	});

	it("runs the W3C flow: VAPID → PushManager.subscribe → push.subscribe('web')", async () => {
		let subscribeBody: unknown;
		const fetchImpl: FetchLike = async (u, init) => {
			// "q_-A" is base64url containing BOTH `-` and `_` — exercises the base64url→base64 replacement
			// branches and decodes to bytes [171, 255, 128].
			if (u.endsWith("/vapid-key")) {
				return new Response(JSON.stringify({ public_key: "q_-A" }), { status: 200 });
			}
			subscribeBody = init?.body;
			return new Response(JSON.stringify({ device_id: 777 }), { status: 201 });
		};
		let subscribeArgs: { userVisibleOnly?: boolean; applicationServerKey?: unknown } = {};
		stubBrowser(async (opts) => {
			subscribeArgs = opts as typeof subscribeArgs;
			return {
				endpoint: "https://push.example.com/ep",
				getKey: (name: string) =>
					name === "p256dh"
						? new Uint8Array([1, 2, 3]).buffer
						: name === "auth"
							? new Uint8Array([4, 5]).buffer
							: null,
			};
		});

		const push = makePush(fetchImpl);
		const id = await push.enableWebPush({ channels: ["acme.x"] });

		expect(id).toBe("777");
		expect(subscribeArgs.userVisibleOnly).toBe(true);
		// VAPID base64url → applicationServerKey bytes (witnesses the actual decode, not just the type).
		expect(subscribeArgs.applicationServerKey).toBeInstanceOf(Uint8Array);
		expect(Array.from(subscribeArgs.applicationServerKey as Uint8Array)).toEqual([171, 255, 128]);
		const body = JSON.parse(subscribeBody as string);
		expect(body.platform).toBe("web");
		expect(body.channels).toEqual(["acme.x"]); // EnableWebPushOptions.channels → wire
		expect(body.endpoint).toBe("https://push.example.com/ep");
		expect(body.p256dh_key).toBe("AQID"); // base64url of [1,2,3]
		expect(body.auth_secret).toBe("BAU"); // base64url of [4,5]
	});

	it("uses an explicitly-supplied serviceWorker registration (never touching navigator.ready)", async () => {
		let subscribeBody: unknown;
		const push = makePush(async (u, init) => {
			if (u.endsWith("/vapid-key")) {
				return new Response(JSON.stringify({ public_key: "BNcR" }), { status: 200 });
			}
			subscribeBody = init?.body;
			return new Response(JSON.stringify({ device_id: 888 }), { status: 201 });
		});
		// Capability gate must still pass (`serviceWorker` present, PushManager defined) but the explicit
		// registration means `navigator.serviceWorker.ready` MUST NOT be read.
		vi.stubGlobal("PushManager", class {});
		vi.stubGlobal("navigator", {
			serviceWorker: {
				get ready(): never {
					throw new Error("ready must not be read when a serviceWorker is supplied");
				},
			},
		});
		const registration = {
			pushManager: {
				subscribe: async () => ({
					endpoint: "https://push.example.com/explicit",
					getKey: (name: string) =>
						name === "p256dh" ? new Uint8Array([9]).buffer : new Uint8Array([8]).buffer,
				}),
			},
		} as unknown as ServiceWorkerRegistration;

		const id = await push.enableWebPush({ channels: ["acme.x"], serviceWorker: registration });

		expect(id).toBe("888");
		expect(JSON.parse(subscribeBody as string).endpoint).toBe("https://push.example.com/explicit");
	});

	it("throws ProtocolError when the subscription is missing its keys", async () => {
		stubBrowser(async () => ({ endpoint: "https://ep", getKey: () => null }));
		const push = makePush(
			async () => new Response(JSON.stringify({ public_key: "BNcR" }), { status: 200 }),
		);
		await expect(push.enableWebPush({ channels: ["a"] })).rejects.toBeInstanceOf(ProtocolError);
	});

	it("throws ProtocolError when the VAPID key is not valid base64url", async () => {
		stubBrowser(async () => ({ endpoint: "https://ep", getKey: () => new Uint8Array([1]).buffer }));
		const push = makePush(
			async () => new Response(JSON.stringify({ public_key: "@@@not-base64@@@" }), { status: 200 }),
		);
		await expect(push.enableWebPush({ channels: ["a"] })).rejects.toBeInstanceOf(ProtocolError);
	});
});

describe("PushClient — getVapidKey", () => {
	it("returns the tenant's public_key", async () => {
		const push = makePush(
			async () => new Response(JSON.stringify({ public_key: "BNcR-key" }), { status: 200 }),
		);
		expect(await push.getVapidKey()).toBe("BNcR-key");
	});

	it("throws ProtocolError when public_key is missing", async () => {
		const push = makePush(async () => new Response(JSON.stringify({}), { status: 200 }));
		await expect(push.getVapidKey()).rejects.toBeInstanceOf(ProtocolError);
	});
});
