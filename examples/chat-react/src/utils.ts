export interface ChatMessage {
	id: string;
	channel: string;
	sender: string;
	text: string;
	ts: number;
	type: "user" | "system" | "error";
}

export function decodeTokenPayload(token: string): {
	sub?: string;
	tenant_id?: string;
	groups?: string[];
} {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return {};
		const payload = JSON.parse(atob(parts[1]));
		return {
			sub: payload.sub,
			tenant_id: payload.tenant_id,
			groups: Array.isArray(payload.groups) ? payload.groups : undefined,
		};
	} catch {
		return {};
	}
}

export function formatTimestamp(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

let messageCounter = 0;

export function createMessageId(): string {
	return `msg-${Date.now()}-${++messageCounter}`;
}
