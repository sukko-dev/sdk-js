// Push subscription management (T038, FR-013) — register/unregister devices + fetch the VAPID key.
// Enterprise-gated REST over the gateway (`/api/v1/push/*`); a lower edition yields a typed
// `EditionRequiredError`, an outage a `ServiceUnavailableError`.
//
// This SDK does NOT *receive* push — a Node backend is neither a Web Push nor an FCM/APNs target. The
// use-case is registering a mobile app's device token or a browser's Web Push subscription on the
// user's behalf. There is no list endpoint, so the caller persists the returned `deviceId`.
//
// `deviceId` is an int64. It is a STRING at the JS boundary (an int64 above 2^53 is unsafe as a JS
// `number`) but rides the wire as an UNQUOTED number literal — so `unsubscribe` builds the request
// body by hand and `subscribe` extracts `device_id` from the raw response text (never `JSON.parse`,
// which would round it through a lossy `number`).

import { registerSecret } from "./_redact";
import { ConfigurationError, ProtocolError } from "./errors";
import type { HttpApi } from "./http";

export type PushPlatform = "web" | "android" | "ios";

export interface PushSubscribeOptions {
	/** The device's platform. */
	platform: PushPlatform;
	/** Channels the device should receive push for (tenant-prefixed). */
	channels: string[];
	/** FCM/APNs device token — required for `android`/`ios`. */
	token?: string;
	/** Web Push endpoint — required (with the keys) for `web`. */
	endpoint?: string;
	/** Web Push p256dh key — required for `web`. */
	p256dhKey?: string;
	/** Web Push auth secret — required for `web`. */
	authSecret?: string;
}

const SUBSCRIBE_PATH = "/api/v1/push/subscribe";
const VAPID_PATH = "/api/v1/push/vapid-key";
// Cheap digit-only pre-filter (≤ 19 chars) — the injection guard for the hand-built body. Canonical
// value + int64 range are then enforced with BigInt (see `assertDeviceId`).
const DEVICE_ID_DIGITS = /^\d{1,19}$/;
const INT64_MAX = 9223372036854775807n;

/** The `client.push` namespace — Enterprise-gated push subscription management over REST. */
export class PushClient {
	private readonly http: HttpApi;

	constructor(http: HttpApi) {
		this.http = http;
	}

	/**
	 * Register a device for push on `channels`; resolves to its `deviceId` (an int64 AS A STRING — the
	 * caller persists it, there is no list endpoint). `token` is required for `android`/`ios`;
	 * `endpoint` + `p256dhKey` + `authSecret` for `web`.
	 */
	async subscribe(options: PushSubscribeOptions): Promise<string> {
		const { platform, channels, token, endpoint, p256dhKey, authSecret } = options;
		// §II: validate the per-platform required fields locally rather than round-trip to a 400.
		if (platform === "web" && !(endpoint && p256dhKey && authSecret)) {
			throw new ConfigurationError("web push requires endpoint, p256dhKey, and authSecret");
		}
		if ((platform === "android" || platform === "ios") && !token) {
			throw new ConfigurationError(`${platform} push requires a device token`);
		}
		registerSecret(token, p256dhKey, authSecret); // §IX: mask if a failing request embeds them

		const body: Record<string, unknown> = { platform, channels };
		if (token !== undefined) body.token = token;
		if (endpoint !== undefined) body.endpoint = endpoint;
		if (p256dhKey !== undefined) body.p256dh_key = p256dhKey;
		if (authSecret !== undefined) body.auth_secret = authSecret;

		const text = await this.http.requestText("POST", SUBSCRIBE_PATH, {
			json: body,
			editionGated: true,
		});
		return extractDeviceId(text);
	}

	/** Remove a device's push registration. Requires a JWT — a 401 for an api-key surfaces typed. */
	async unsubscribe(deviceId: string): Promise<void> {
		assertDeviceId(deviceId);
		// device_id must be an UNQUOTED int64 literal — build the body by hand (`JSON.stringify` would
		// quote the string; `Number()` would round it). `assertDeviceId` guarantees it is injection-safe
		// AND a canonical in-range int64, so the literal is always valid JSON the gateway accepts.
		await this.http.requestText("DELETE", SUBSCRIBE_PATH, {
			body: `{"device_id":${deviceId}}`,
			editionGated: true,
		});
	}

	/** The tenant's VAPID public key (for a web frontend to create a Web Push subscription). */
	async getVapidKey(): Promise<string> {
		const result = await this.http.request<{ public_key?: unknown }>("GET", VAPID_PATH, {
			editionGated: true,
		});
		if (typeof result.public_key !== "string") {
			throw new ProtocolError("vapid-key response had no public_key");
		}
		return result.public_key;
	}

	/**
	 * Browser convenience: run the full W3C Push API subscribe flow and register the resulting Web Push
	 * subscription — fetch the tenant VAPID key, `PushManager.subscribe({userVisibleOnly, applicationServerKey})`
	 * against a service-worker registration, then `subscribe('web', …)` with the endpoint + p256dh/auth
	 * keys. Resolves to the `deviceId`. Browser-only: the `serviceWorker`/`PushManager` capability is
	 * checked at CALL time (never at module scope), so importing the SDK under Node stays safe (§XI).
	 *
	 * §XII prior art: this is the canonical W3C Push API flow documented by MDN
	 * (https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe) — `userVisibleOnly: true`
	 * (Chrome/Edge reject the promise without it), `applicationServerKey` as the VAPID public key decoded
	 * from base64url to bytes (`urlBase64ToUint8Array`, verbatim the MDN helper), and `getKey('p256dh'|'auth')`
	 * to extract the subscription keys.
	 */
	async enableWebPush(options: EnableWebPushOptions): Promise<string> {
		if (
			typeof navigator === "undefined" ||
			!("serviceWorker" in navigator) ||
			typeof PushManager === "undefined"
		) {
			throw new ConfigurationError(
				"enableWebPush requires a browser with serviceWorker + PushManager support",
			);
		}
		const registration = options.serviceWorker ?? (await navigator.serviceWorker.ready);
		const vapidKey = await this.getVapidKey();
		const subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(vapidKey),
		});
		const p256dh = subscription.getKey("p256dh");
		const auth = subscription.getKey("auth");
		if (p256dh === null || auth === null) {
			throw new ProtocolError("web push subscription is missing its p256dh/auth keys");
		}
		return this.subscribe({
			platform: "web",
			channels: options.channels,
			endpoint: subscription.endpoint,
			p256dhKey: arrayBufferToBase64Url(p256dh),
			authSecret: arrayBufferToBase64Url(auth),
		});
	}
}

export interface EnableWebPushOptions {
	/** Channels the subscription should receive push for (tenant-prefixed). */
	channels: string[];
	/** The service-worker registration to subscribe against. Default: `navigator.serviceWorker.ready`. */
	serviceWorker?: ServiceWorkerRegistration;
}

/** VAPID public key (base64url) → the `Uint8Array` `applicationServerKey` PushManager expects. */
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
	const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
	// §XI: the VAPID key is untrusted server input — a non-base64 value makes `atob` throw a raw
	// DOMException; surface it as a typed ProtocolError instead of leaking a non-SDK error.
	let raw: string;
	try {
		raw = atob(base64);
	} catch {
		throw new ProtocolError("vapid-key response was not valid base64url");
	}
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

/** A subscription key (`ArrayBuffer` from `getKey`) → the base64url the gateway expects. */
function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validate `deviceId` is a canonical positive int64 (§II — reject locally, not via a gateway 400). The
 * digit pre-filter guards the raw-body literal against injection; BigInt then rejects leading zeros
 * (which would emit malformed JSON) and out-of-int64-range values. */
function assertDeviceId(deviceId: string): void {
	const invalid = (): never => {
		throw new ConfigurationError(`invalid deviceId (expected a positive int64): ${deviceId}`);
	};
	if (!DEVICE_ID_DIGITS.test(deviceId)) invalid();
	const n = BigInt(deviceId);
	// `n.toString() !== deviceId` rejects leading zeros ("0123" → "123"); the bounds enforce positive int64.
	if (n.toString() !== deviceId || n < 1n || n > INT64_MAX) invalid();
}

/** Extract the int64 `device_id` from the raw subscribe response body as a STRING (no precision loss). */
function extractDeviceId(text: string): string {
	const match = /"device_id"\s*:\s*(\d+)/.exec(text);
	if (match === null) {
		throw new ProtocolError("push subscribe response had no int64 device_id");
	}
	return match[1];
}
