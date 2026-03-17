import { SukkoClient } from "@sukko/sdk";
import { SukkoProvider } from "@sukko/react";
import { WebSocketTransport } from "@sukko/websocket";
import { useCallback, useRef, useState } from "react";
import type { ChatMessage } from "../utils";
import { ConnectionPanel } from "./ConnectionPanel";
import { ChannelSidebar } from "./ChannelSidebar";
import { MessageFeed } from "./MessageFeed";
import { MessageInput } from "./MessageInput";

export function App() {
	const [client, setClient] = useState<SukkoClient | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
	const [token, setToken] = useState("");
	const [wsUrl, setWsUrl] = useState("ws://localhost:3000/ws");
	const clientRef = useRef<SukkoClient | null>(null);

	const addMessage = useCallback((msg: ChatMessage) => {
		setMessages((prev) => {
			const next = [...prev, msg];
			return next.length > 200 ? next.slice(-200) : next;
		});
	}, []);

	const handleConnect = useCallback(() => {
		if (clientRef.current) {
			clientRef.current.disconnect();
		}

		const transport = new WebSocketTransport({ url: wsUrl });
		const newClient = new SukkoClient({
			transport,
			token,
			autoConnect: false,
			reconnect: true,
		});

		clientRef.current = newClient;
		setClient(newClient);
		newClient.connect();
	}, [wsUrl, token]);

	const handleDisconnect = useCallback(() => {
		if (clientRef.current) {
			clientRef.current.disconnect();
			clientRef.current = null;
			setClient(null);
		}
	}, []);

	const connectionPanel = (
		<ConnectionPanel
			wsUrl={wsUrl}
			token={token}
			connected={!!client}
			onWsUrlChange={setWsUrl}
			onTokenChange={setToken}
			onConnect={handleConnect}
			onDisconnect={handleDisconnect}
		/>
	);

	if (client) {
		return (
			<SukkoProvider client={client}>
				{connectionPanel}
				<div className="main-layout">
					<ChannelSidebar
						token={token}
						selectedChannel={selectedChannel}
						onSelectChannel={setSelectedChannel}
						onMessage={addMessage}
					/>
					<div className="message-feed">
						<MessageFeed messages={messages} onMessage={addMessage} />
						<MessageInput
							token={token}
							selectedChannel={selectedChannel}
							onMessage={addMessage}
						/>
					</div>
				</div>
			</SukkoProvider>
		);
	}

	return (
		<>
			{connectionPanel}
			<div className="main-layout">
				<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8b949e" }}>
					Enter a WebSocket URL and token, then click Connect.
				</div>
			</div>
		</>
	);
}
