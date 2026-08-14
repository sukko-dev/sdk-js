/**
 * Generic typed event emitter — Socket.IO pattern with zero dependencies.
 *
 * Type-safe `.on()/.off()/.emit()` where event names and handler signatures
 * are enforced at compile time via the EventMap generic parameter.
 */

// biome-ignore lint/suspicious/noExplicitAny: EventMap must accept any function signature
export type EventMap = { [K: string]: (...args: any[]) => void };

export class TypedEventEmitter<T extends EventMap = EventMap> {
	private listeners = new Map<keyof T, Set<(...args: unknown[]) => void>>();

	/**
	 * Register an event listener. Returns an unsubscribe function.
	 *
	 * ```ts
	 * const off = emitter.on("message", handler);
	 * off(); // remove listener
	 * ```
	 */
	on<K extends keyof T>(event: K, handler: T[K]): () => void {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event)!.add(handler);

		return () => {
			this.off(event, handler);
		};
	}

	/** Remove a specific event listener. */
	off<K extends keyof T>(event: K, handler: T[K]): void {
		this.listeners.get(event)?.delete(handler);
	}

	/** Remove all listeners, optionally for a specific event. */
	removeAllListeners(event?: keyof T): void {
		if (event !== undefined) {
			this.listeners.delete(event);
		} else {
			this.listeners.clear();
		}
	}

	/** Get the number of listeners for a specific event. */
	listenerCount(event: keyof T): number {
		return this.listeners.get(event)?.size ?? 0;
	}

	/**
	 * Emit an event to all registered listeners. Each listener is invoked in isolation: a throwing
	 * listener neither aborts the fan-out to the other listeners nor propagates into the caller. This is
	 * load-bearing on the hot delivery path — the emitter is the non-back-pressured tap, and a throwing
	 * `.on("message")` handler must not break the authoritative `messages()` stream or starve other
	 * listeners (NFR-001). The caught error is routed to the SDK logger once logging is wired (parallel
	 * to `_redact`); until then it is contained here rather than surfaced.
	 */
	protected emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
		const handlers = this.listeners.get(event);
		if (!handlers) return;
		// Snapshot so a listener that unsubscribes/subscribes during dispatch can't disturb iteration.
		for (const handler of [...handlers]) {
			try {
				handler(...args);
			} catch {
				// Contained — see the method doc. A user-callback throw must not break delivery.
			}
		}
	}
}
