import type { SukkoClient } from "@sukko/sdk";
import { useContext } from "react";
import { SukkoContext } from "../context";

/**
 * Access the SukkoClient from context.
 * Throws if used outside of `<SukkoProvider>`.
 */
export function useSukkoClient(): SukkoClient {
	const client = useContext(SukkoContext);
	if (!client) {
		throw new Error("useSukkoClient must be used within a <SukkoProvider>");
	}
	return client;
}
