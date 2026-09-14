import { describe, expect, it, vi } from "vitest";
import {
	type MessagingAdapter,
	type PushCapableClient,
	PushPermissionDeniedError,
	enableMobilePush,
} from "../src/index";

// A fake push surface: subscribe returns a fresh device id per call so rotations are observable.
function makeClient(): {
	client: PushCapableClient;
	subscribe: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
} {
	let n = 0;
	const subscribe = vi.fn(async () => `device-${++n}`);
	const unsubscribe = vi.fn(async () => {});
	return { client: { push: { subscribe, unsubscribe } }, subscribe, unsubscribe };
}

// A fake MessagingAdapter with a manually-fired token-refresh listener.
function makeAdapter(
	firstToken: string,
	opts: { granted?: boolean } = {},
): {
	adapter: MessagingAdapter;
	fireRefresh: (token: string) => void;
	stop: ReturnType<typeof vi.fn>;
} {
	let listener: ((t: string) => void) | null = null;
	const stop = vi.fn(() => {
		listener = null;
	});
	const adapter: MessagingAdapter = {
		requestPermission: async () => opts.granted ?? true,
		getToken: async () => firstToken,
		onTokenRefresh: (l) => {
			listener = l;
			return stop;
		},
	};
	return { adapter, fireRefresh: (t) => listener?.(t), stop };
}

const flush = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("enableMobilePush", () => {
	it("registers with the option's platform + the adapter's token, unmapped", async () => {
		const { client, subscribe } = makeClient();
		const { adapter } = makeAdapter("fcm-1");
		const reg = await enableMobilePush(client, adapter, {
			platform: "android",
			channels: ["acme.alerts"],
		});
		expect(subscribe).toHaveBeenCalledWith({
			platform: "android",
			token: "fcm-1",
			channels: ["acme.alerts"],
		});
		expect(reg.deviceId).toBe("device-1");
	});

	it("throws PushPermissionDeniedError when permission is denied", async () => {
		const { client, subscribe } = makeClient();
		const { adapter } = makeAdapter("apns-1", { granted: false });
		await expect(
			enableMobilePush(client, adapter, { platform: "ios", channels: ["a.b"] }),
		).rejects.toBeInstanceOf(PushPermissionDeniedError);
		expect(subscribe).not.toHaveBeenCalled();
	});

	it("re-registers with the new token when it rotates (same platform)", async () => {
		const { client, subscribe } = makeClient();
		const { adapter, fireRefresh } = makeAdapter("fcm-1");
		const reg = await enableMobilePush(client, adapter, { platform: "android", channels: ["a.b"] });
		fireRefresh("fcm-2");
		await flush();
		expect(subscribe).toHaveBeenLastCalledWith({
			platform: "android",
			token: "fcm-2",
			channels: ["a.b"],
		});
		expect(reg.deviceId).toBe("device-2"); // deviceId rotated
	});

	it("routes a rotation re-registration failure to onError (no silent loss)", async () => {
		const { client, subscribe } = makeClient();
		subscribe
			.mockImplementationOnce(async () => "device-1")
			.mockRejectedValueOnce(new Error("boom"));
		const { adapter, fireRefresh } = makeAdapter("fcm-1");
		const onError = vi.fn();
		await enableMobilePush(client, adapter, { platform: "android", channels: ["a.b"], onError });
		fireRefresh("fcm-2");
		await flush();
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0]?.[0] as Error).message).toBe("boom");
	});

	it("disable() stops listening and unsubscribes the device", async () => {
		const { client, unsubscribe } = makeClient();
		const { adapter, stop } = makeAdapter("apns-1");
		const reg = await enableMobilePush(client, adapter, { platform: "ios", channels: ["a.b"] });
		await reg.disable();
		expect(stop).toHaveBeenCalledOnce();
		expect(unsubscribe).toHaveBeenCalledWith("device-1");
	});

	it("a rotation that resolves after disable() leaves no live registration", async () => {
		const { client, subscribe, unsubscribe } = makeClient();
		// Make the rotation subscribe hang until we release it, so disable() runs mid-flight.
		let release: (id: string) => void = () => {};
		subscribe
			.mockImplementationOnce(async () => "device-1")
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						release = resolve;
					}),
			);
		const { adapter, fireRefresh } = makeAdapter("fcm-1");
		const reg = await enableMobilePush(client, adapter, { platform: "android", channels: ["a.b"] });

		fireRefresh("fcm-2"); // rotation subscribe now pending
		await flush();
		await reg.disable(); // disable while the re-register is in flight
		release("device-2"); // the pending subscribe resolves AFTER disable
		await flush();

		// The just-created device-2 must be cleaned up, not left dangling; deviceId did not rotate to it.
		expect(unsubscribe).toHaveBeenCalledWith("device-2");
		expect(reg.deviceId).toBe("device-1");
	});
});
