import type { SukkoClient } from "@sukko/sdk";
import { getContext, setContext } from "svelte";

const SUKKO_KEY = Symbol("sukko");

/**
 * Provide a SukkoClient to the component tree via Svelte's context API.
 * Must be called during component initialization (top-level script).
 *
 * ```svelte
 * <script>
 *   import { setSukkoClient } from '@sukko/svelte';
 *   setSukkoClient(client);
 * </script>
 * ```
 */
export function setSukkoClient(client: SukkoClient): void {
	setContext(SUKKO_KEY, client);
}

/**
 * Access the SukkoClient from context.
 * Throws if called outside a component that called `setSukkoClient`.
 */
export function getSukkoClient(): SukkoClient {
	const client = getContext<SukkoClient | undefined>(SUKKO_KEY);
	if (!client) {
		throw new Error(
			"getSukkoClient must be called within a component tree where setSukkoClient was called",
		);
	}
	return client;
}
