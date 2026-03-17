<script lang="ts">
import { SukkoClient } from "@sukko/sdk";
import { WebSocketTransport } from "@sukko/websocket";
import type { ChatMessage } from "./utils";
import ConnectionPanel from "./components/ConnectionPanel.svelte";
import ChatLayout from "./components/ChatLayout.svelte";

let wsUrl = $state("ws://localhost:3000/ws");
let token = $state("");
let client = $state<SukkoClient | null>(null);
let messages = $state<ChatMessage[]>([]);
let selectedChannel = $state<string | null>(null);

function addMessage(msg: ChatMessage) {
	messages = [...messages, msg].slice(-200);
}

function handleConnect() {
	if (client) {
		client.disconnect();
	}

	const transport = new WebSocketTransport({ url: wsUrl });
	const newClient = new SukkoClient({
		transport,
		token,
		autoConnect: false,
		reconnect: true,
	});

	client = newClient;
	newClient.connect();
}

function handleDisconnect() {
	if (client) {
		client.disconnect();
		client = null;
	}
}
</script>

{#if client}
	<!-- ChatLayout sets Svelte context during its initialization -->
	<ChatLayout
		{client}
		{wsUrl}
		{token}
		{messages}
		{selectedChannel}
		onWsUrlChange={(v) => wsUrl = v}
		onTokenChange={(v) => token = v}
		onConnect={handleConnect}
		onDisconnect={handleDisconnect}
		onSelectChannel={(ch) => selectedChannel = ch}
		onMessage={addMessage}
	/>
{:else}
	<ConnectionPanel
		{wsUrl}
		{token}
		connected={false}
		connectionState="disconnected"
		onWsUrlChange={(v) => wsUrl = v}
		onTokenChange={(v) => token = v}
		onConnect={handleConnect}
		onDisconnect={handleDisconnect}
	/>
	<div class="main-layout">
		<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: #8b949e">
			Enter a WebSocket URL and token, then click Connect.
		</div>
	</div>
{/if}
