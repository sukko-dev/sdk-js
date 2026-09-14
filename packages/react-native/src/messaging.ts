import { type PushClient, SukkoError } from "@sukko/sdk";

/** The push platform, as the gateway routes it. `ios` is delivered via APNs (see {@link enableMobilePush}). */
export type MobilePushPlatform = "ios" | "android";

/** The subset of a client {@link enableMobilePush} needs — a `SukkoClient` satisfies it. */
export type PushCapableClient = {
	push: Pick<PushClient, "subscribe" | "unsubscribe">;
};

/**
 * A caller-supplied bridge to the app's native messaging library — e.g. `@react-native-firebase/messaging`
 * or `expo-notifications`. The SDK depends on **no** push library; the app writes this thin adapter over
 * whatever it already uses.
 *
 * The SDK is a push *registrar*, not a *receiver*: incoming notifications go native FCM/APNs → OS → the
 * app's own handler, never over the SDK. There is therefore no `onMessage` here.
 */
export interface MessagingAdapter {
	/** Prompt for (or report) push permission; resolves to whether it is granted. */
	requestPermission(): Promise<boolean>;
	/** The current native device push token. */
	getToken(): Promise<string>;
	/** Subscribe to token rotation. Returns an unsubscribe function. */
	onTokenRefresh(listener: (token: string) => void): () => void;
}

/** Thrown by {@link enableMobilePush} when the user denies push permission. */
export class PushPermissionDeniedError extends SukkoError {}

export interface EnableMobilePushOptions {
	/**
	 * The device's platform, which routes the push. It is a per-device constant (from React Native's
	 * `Platform.OS`), not a per-token value — so it is set once here, not returned by the adapter.
	 */
	platform: MobilePushPlatform;
	/** Channels the device should receive push for (tenant-prefixed). */
	channels: string[];
	/**
	 * Called if a re-registration triggered by token rotation fails. Without it such a failure would be a
	 * silent loss of push (a later rotation stops delivery with no signal) or an unhandled rejection.
	 */
	onError?: (error: unknown) => void;
}

/** A live mobile-push registration returned by {@link enableMobilePush}. */
export interface MobilePushRegistration {
	/**
	 * The current server-side device id (int64 string). It **rotates** when the native token refreshes,
	 * so a persisted copy can go stale — read it from here, or track rotations via your own store.
	 */
	readonly deviceId: string;
	/** Stop listening for token rotations and unsubscribe the device from push. */
	disable(): Promise<void>;
}

/**
 * Register a React Native device for push on `channels`, using a caller-supplied {@link MessagingAdapter}
 * (so the SDK carries no dependency on any push library). Prompts for permission, registers the current
 * token, and automatically re-registers when the native token rotates.
 *
 * **iOS-via-Firebase is not supported.** The gateway routes push by `platform` (`ios` → APNs); an iOS app
 * using Firebase holds an *FCM* token but can only send `platform: "ios"`, which the server would deliver
 * via APNs and fail. Use APNs directly on iOS, or FCM on Android. (Cross-provider iOS would need a
 * `provider` field on the push API — a separate upstream change.)
 *
 * On token rotation the previous registration is left in place — FCM/APNs invalidate stale tokens on
 * their own; it is not explicitly unsubscribed.
 *
 * @throws {PushPermissionDeniedError} if the user denies permission.
 */
export async function enableMobilePush(
	client: PushCapableClient,
	adapter: MessagingAdapter,
	options: EnableMobilePushOptions,
): Promise<MobilePushRegistration> {
	const { platform, channels } = options;

	if (!(await adapter.requestPermission())) {
		throw new PushPermissionDeniedError("push permission was denied");
	}

	let deviceId = await client.push.subscribe({
		platform,
		token: await adapter.getToken(),
		channels,
	});
	let disabled = false;

	async function reregister(token: string): Promise<void> {
		if (disabled) return;
		try {
			const id = await client.push.subscribe({ platform, token, channels });
			// Post-await revalidation: if disable() ran while this subscribe was in flight, the new
			// registration would be left dangling — clean it up instead of tracking it.
			if (disabled) {
				await client.push.unsubscribe(id);
				return;
			}
			deviceId = id;
		} catch (error) {
			options.onError?.(error);
		}
	}

	const stopRefresh = adapter.onTokenRefresh((token) => void reregister(token));

	return {
		get deviceId(): string {
			return deviceId;
		},
		async disable(): Promise<void> {
			disabled = true;
			stopRefresh();
			await client.push.unsubscribe(deviceId);
		},
	};
}
