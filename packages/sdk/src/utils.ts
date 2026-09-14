export interface ParsedChannel {
	tenant: string;
	suffix: string;
}

/**
 * Build a channel string from a tenant and a suffix.
 *
 * Format: `{tenant}.{suffix}`. The tenant is a single segment (the part before
 * the first dot) and MUST NOT contain a dot; the suffix is an opaque dotted
 * path (it may itself contain dots) that the server matches against
 * permission/routing patterns. No fixed suffix-segment count is imposed.
 *
 * Throws a `TypeError` if the tenant is empty or contains a dot, or the suffix
 * is empty. These guards keep `buildChannel` symmetric with `parseChannel`:
 * every value it returns parses back to the identical `{tenant, suffix}` and is
 * never rejected.
 */
export function buildChannel(tenant: string, suffix: string): string {
	if (tenant === "" || tenant.includes(".") || suffix === "") {
		throw new TypeError(
			"buildChannel: tenant must be a non-empty single segment (no dots) and suffix must be non-empty",
		);
	}
	return `${tenant}.${suffix}`;
}

/**
 * Parse a channel string into its tenant prefix and suffix.
 *
 * A channel is `{tenant}.{suffix}` (minimum 2 dot-separated parts). The tenant
 * is the segment before the first dot; the suffix is the entire remainder,
 * kept verbatim (opaque — interior dots and empty segments such as
 * `acme..trades` are preserved).
 *
 * Returns `null` when the channel has no dot, an empty tenant (leading dot),
 * or an empty suffix.
 */
export function parseChannel(channel: string): ParsedChannel | null {
	const firstDot = channel.indexOf(".");
	if (firstDot <= 0) return null; // no dot, or empty tenant (leading dot)
	const suffix = channel.slice(firstDot + 1);
	if (suffix === "") return null; // empty whole suffix
	return { tenant: channel.slice(0, firstDot), suffix };
}
