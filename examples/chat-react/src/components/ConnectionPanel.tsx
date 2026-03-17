import { useConnectionState } from "@sukko/react";

function StatusDot() {
	const { state } = useConnectionState();
	return (
		<div className="status-indicator">
			<span className={`status-dot ${state}`} />
			<span>{state}</span>
		</div>
	);
}

export function ConnectionPanel(props: {
	wsUrl: string;
	token: string;
	connected: boolean;
	onWsUrlChange: (url: string) => void;
	onTokenChange: (token: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
}) {
	return (
		<div className="connection-bar">
			<input
				type="text"
				value={props.wsUrl}
				onChange={(e) => props.onWsUrlChange(e.target.value)}
				placeholder="ws://localhost:3000/ws"
				disabled={props.connected}
			/>
			<textarea
				value={props.token}
				onChange={(e) => props.onTokenChange(e.target.value)}
				placeholder="Paste JWT token..."
				disabled={props.connected}
			/>
			{props.connected ? (
				<button type="button" className="btn-disconnect" onClick={props.onDisconnect}>
					Disconnect
				</button>
			) : (
				<button type="button" className="btn-connect" onClick={props.onConnect} disabled={!props.token}>
					Connect
				</button>
			)}
			{props.connected && <StatusDot />}
		</div>
	);
}
