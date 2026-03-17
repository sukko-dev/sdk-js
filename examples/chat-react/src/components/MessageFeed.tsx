import { useSukkoEvent } from "@sukko/react";
import { useEffect, useRef } from "react";
import type { ChatMessage } from "../utils";
import { createMessageId, formatTimestamp } from "../utils";

export function MessageFeed(props: {
	messages: ChatMessage[];
	onMessage: (msg: ChatMessage) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new messages
	useEffect(() => {
		if (listRef.current) {
			listRef.current.scrollTop = listRef.current.scrollHeight;
		}
	}, [props.messages.length]);

	// Capture error events as system messages
	useSukkoEvent("error", (err) => {
		props.onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: `Error: ${err.message ?? "Unknown error"}`,
			ts: Date.now(),
			type: "error",
		});
	});

	useSukkoEvent("publishError", (err) => {
		props.onMessage({
			id: createMessageId(),
			channel: err.channel ?? "",
			sender: "system",
			text: `Publish error: ${err.message ?? "Failed to publish"}`,
			ts: Date.now(),
			type: "error",
		});
	});

	useSukkoEvent("subscribeError", (err) => {
		props.onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: `Subscribe error: ${err.message ?? "Failed to subscribe"}`,
			ts: Date.now(),
			type: "error",
		});
	});

	useSukkoEvent("stateChange", (state) => {
		props.onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: `Connection: ${state}`,
			ts: Date.now(),
			type: "system",
		});
	});

	useSukkoEvent("authAck", () => {
		props.onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: "Token refreshed successfully",
			ts: Date.now(),
			type: "system",
		});
	});

	useSukkoEvent("authError", (err) => {
		props.onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: `Auth error: ${err.message ?? "Token refresh failed"}`,
			ts: Date.now(),
			type: "error",
		});
	});

	return (
		<div className="message-list" ref={listRef}>
			{props.messages.map((msg) => (
				<div key={msg.id} className={`message ${msg.type}`}>
					<span className="msg-time">{formatTimestamp(msg.ts)}</span>
					{msg.channel && <span className="msg-channel">[{msg.channel}]</span>}
					<span className="msg-sender">{msg.sender}:</span>
					<span className="msg-text">{msg.text}</span>
				</div>
			))}
		</div>
	);
}
