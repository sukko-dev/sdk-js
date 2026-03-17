import { useConnectionState, useSukkoClient } from "@sukko/react";
import { useCallback, useState } from "react";
import type { ChatMessage } from "../utils";
import { createMessageId, decodeTokenPayload } from "../utils";

export function MessageInput(props: {
	token: string;
	selectedChannel: string | null;
	onMessage: (msg: ChatMessage) => void;
}) {
	const client = useSukkoClient();
	const { isConnected } = useConnectionState();
	const [text, setText] = useState("");

	const canSend = isConnected && !!props.selectedChannel && text.trim().length > 0;

	const handleSend = useCallback(() => {
		if (!canSend || !props.selectedChannel) return;

		const claims = decodeTokenPayload(props.token);
		const sender = claims.sub ?? "anonymous";

		client.publish(props.selectedChannel, {
			sender,
			text: text.trim(),
			ts: Date.now(),
		});

		props.onMessage({
			id: createMessageId(),
			channel: props.selectedChannel,
			sender,
			text: text.trim(),
			ts: Date.now(),
			type: "user",
		});

		setText("");
	}, [canSend, text, props.selectedChannel, client, props.onMessage]);

	const handleRefreshToken = useCallback(async () => {
		const newToken = prompt("Enter new JWT token:");
		if (newToken) {
			client.updateToken(newToken);
			props.onMessage({
				id: createMessageId(),
				channel: "",
				sender: "system",
				text: "Token updated. Send auth refresh to apply.",
				ts: Date.now(),
				type: "system",
			});
		}
	}, [client, props.onMessage]);

	const handleReplay = useCallback(() => {
		client.reconnectWithReplay();
		props.onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: "Reconnect with replay requested.",
			ts: Date.now(),
			type: "system",
		});
	}, [client, props.onMessage]);

	return (
		<>
			<div className="input-bar">
				{props.selectedChannel && (
					<span className="channel-label">{props.selectedChannel}</span>
				)}
				<input
					type="text"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleSend()}
					placeholder={props.selectedChannel ? "Type a message..." : "Select a channel"}
					disabled={!isConnected}
				/>
				<button type="button" onClick={handleSend} disabled={!canSend}>
					Send
				</button>
			</div>
			<div className="action-bar">
				<button type="button" className="btn-secondary" onClick={handleRefreshToken} disabled={!isConnected}>
					Refresh Token
				</button>
				<button type="button" className="btn-secondary" onClick={handleReplay} disabled={!isConnected}>
					Reconnect with Replay
				</button>
			</div>
		</>
	);
}
