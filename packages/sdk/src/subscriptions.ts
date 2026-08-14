// Subscription state (FR-009). Tracks what the client WANTS subscribed (`desired`) versus what the
// server has actually GRANTED (`granted`, from `subscription_ack.subscribed`). The two diverge when
// a channel is filtered by permission — those channels are retained in `desired` so an api-key→JWT
// escalation can re-subscribe exactly the not-granted delta. A new connection epoch keeps `desired`
// and clears `granted` so recovery re-subscribes the full set.

export class SubscriptionState {
	private readonly desired = new Set<string>();
	private readonly granted = new Set<string>();

	/** Record intent to subscribe (before the ack). Returns the channels that were newly added. */
	addDesired(channels: string[]): string[] {
		const added: string[] = [];
		for (const c of channels) {
			if (!this.desired.has(c)) {
				this.desired.add(c);
				added.push(c);
			}
		}
		return added;
	}

	/** Client-initiated unsubscribe: drop from both desired and granted. */
	remove(channels: string[]): void {
		for (const c of channels) {
			this.desired.delete(c);
			this.granted.delete(c);
		}
	}

	/** Apply `subscription_ack.subscribed`: the server granted these channels. */
	markGranted(channels: string[]): void {
		for (const c of channels) {
			if (this.desired.has(c)) this.granted.add(c);
		}
	}

	/**
	 * Apply a forced `unsubscription_ack` (auth refresh / permission change): drop from granted but
	 * KEEP in desired, so a later escalation re-subscribes it via the not-granted delta.
	 */
	markForcedUngranted(channels: string[]): void {
		for (const c of channels) this.granted.delete(c);
	}

	/** Desired channels the server has not granted — the escalation re-subscribe delta (FR-009). */
	notGranted(): string[] {
		return [...this.desired].filter((c) => !this.granted.has(c));
	}

	/** Clear granted state (new connection epoch) while keeping desired, so recovery re-subscribes all. */
	clearGranted(): void {
		this.granted.clear();
	}

	get desiredChannels(): ReadonlySet<string> {
		return this.desired;
	}

	get grantedChannels(): ReadonlySet<string> {
		return this.granted;
	}
}
