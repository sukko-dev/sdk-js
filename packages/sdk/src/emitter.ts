/**
 * Generic typed event emitter — Socket.IO pattern with zero dependencies.
 *
 * Type-safe `.on()/.off()/.emit()` where event names and handler signatures
 * are enforced at compile time via the EventMap generic parameter.
 */

// biome-ignore lint/suspicious/noExplicitAny: EventMap must accept any function signature
export type EventMap = { [K: string]: (...args: any[]) => void };

export class TypedEventEmitter<T extends EventMap = EventMap> {
	private listeners = new Map<keyof T, Set<Function>>();

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

	/** Emit an event to all registered listeners. */
	protected emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
		const handlers = this.listeners.get(event);
		if (!handlers) return;
		for (const handler of handlers) {
			handler(...args);
		}
	}
}
