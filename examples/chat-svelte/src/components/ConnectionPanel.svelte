<script lang="ts">
interface Props {
	wsUrl: string;
	token: string;
	connected: boolean;
	connectionState: string;
	onWsUrlChange: (url: string) => void;
	onTokenChange: (token: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
}

let { wsUrl, token, connected, connectionState, onWsUrlChange, onTokenChange, onConnect, onDisconnect }: Props = $props();
</script>

<div class="connection-bar">
	<input
		type="text"
		value={wsUrl}
		oninput={(e) => onWsUrlChange((e.target as HTMLInputElement).value)}
		placeholder="ws://localhost:3000/ws"
		disabled={connected}
	/>
	<textarea
		value={token}
		oninput={(e) => onTokenChange((e.target as HTMLTextAreaElement).value)}
		placeholder="Paste JWT token..."
		disabled={connected}
	></textarea>
	{#if connected}
		<button class="btn-disconnect" onclick={onDisconnect}>Disconnect</button>
		<div class="status-indicator">
			<span class="status-dot {connectionState}"></span>
			<span>{connectionState}</span>
		</div>
	{:else}
		<button class="btn-connect" disabled={!token} onclick={onConnect}>Connect</button>
	{/if}
</div>
