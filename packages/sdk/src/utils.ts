export interface ParsedChannel {
	tenant: string;
	identifier: string;
	category: string;
}

/**
 * Build a channel string from its components.
 * Format: `{tenant}.{identifier}.{category}`
 */
export function buildChannel(tenant: string, identifier: string, category: string): string {
	return `${tenant}.${identifier}.${category}`;
}

/**
 * Parse a channel string into its components.
 * Returns null if the channel has fewer than 3 dot-separated parts.
 */
export function parseChannel(channel: string): ParsedChannel | null {
	const parts = channel.split(".");
	if (parts.length < 3) return null;
	return {
		tenant: parts[0],
		identifier: parts[1],
		category: parts.slice(2).join("."),
	};
}

/**
 * Extract the category (3rd+ segment) from a channel string.
 * Returns empty string if not enough parts.
 */
export function getChannelCategory(channel: string): string {
	const parts = channel.split(".");
	return parts.length >= 3 ? parts.slice(2).join(".") : "";
}
