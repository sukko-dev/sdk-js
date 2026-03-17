import { SukkoClient } from "@sukko/sdk";
import type { SukkoClientOptions } from "@sukko/sdk";
import { createContext, useEffect, useRef, type ReactNode } from "react";

export const SukkoContext: React.Context<SukkoClient | null> = createContext<SukkoClient | null>(null);

export interface SukkoProviderProps {
	/** Pre-built client instance (takes precedence over options). */
	client?: SukkoClient;
	/** Options to create a new client. Ignored if `client` is provided. */
	options?: SukkoClientOptions;
	children: ReactNode;
}

/**
 * Provides a SukkoClient to the component tree via React context.
 *
 * Either pass a pre-built `client` or `options` to create one automatically.
 * The provider connects on mount and disconnects on unmount (for auto-created clients).
 *
 * ```tsx
 * import { WebSocketTransport } from "@sukko/websocket";
 *
 * const transport = new WebSocketTransport({ url: "wss://example.com/ws" });
 *
 * <SukkoProvider options={{ transport, token }}>
 *   <App />
 * </SukkoProvider>
 * ```
 */
export function SukkoProvider({ client, options, children }: SukkoProviderProps): ReactNode {
	const clientRef = useRef<SukkoClient | null>(null);
	const isOwned = useRef(false);

	// Resolve client: use provided or create from options
	if (!clientRef.current) {
		if (client) {
			clientRef.current = client;
			isOwned.current = false;
		} else if (options) {
			clientRef.current = new SukkoClient({ ...options, autoConnect: false });
			isOwned.current = true;
		}
	}

	// Connect on mount, disconnect on unmount (only for owned clients)
	useEffect(() => {
		const c = clientRef.current;
		if (!c) return;

		if (isOwned.current && c.state === "disconnected") {
			c.connect();
		}

		return () => {
			if (isOwned.current) {
				c.disconnect();
			}
		};
	}, []);

	return <SukkoContext value={clientRef.current}>{children}</SukkoContext>;
}
