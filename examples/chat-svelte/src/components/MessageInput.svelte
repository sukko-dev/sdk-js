<script lang="ts">
import { createConnectionState, getSukkoClient } from "@sukko/svelte";
import type { ChatMessage } from "../utils";
import { createMessageId, decodeTokenPayload } from "../utils";

interface Props {
	token: string;
	selectedChannel: string | null;
	onMessage: (msg: ChatMessage) => void;
}

let { token, selectedChannel, onMessage }: Props = $props();

const client = getSukkoClient();
const connectionStore = createConnectionState();
let isConnected = $state(false);
let text = $state("");

const unsubConnection = connectionStore.subscribe((v) => {
	isConnected = v.isConnected;
});

const canSend = $derived(isConnected && !!selectedChannel && text.trim().length > 0);

function handleSend() {
	if (!canSend || !selectedChannel) return;

	const claims = decodeTokenPayload(token);
	const sender = claims.sub ?? "anonymous";

	client.publish(selectedChannel, {
		sender,
		text: text.trim(),
		ts: Date.now(),
	});

	onMessage({
		id: createMessageId(),
		channel: selectedChannel,
		sender,
		text: text.trim(),
		ts: Date.now(),
		type: "user",
	});

	text = "";
}

function handleRefreshToken() {
	const newToken = prompt("Enter new JWT token:");
	if (newToken) {
		client.updateToken(newToken);
		onMessage({
			id: createMessageId(),
			channel: "",
			sender: "system",
			text: "Token updated. Send auth refresh to apply.",
			ts: Date.now(),
			type: "system",
		});
	}
}

function handleReplay() {
	client.reconnectWithReplay();
	onMessage({
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: "Reconnect with replay requested.",
		ts: Date.now(),
		type: "system",
	});
}
</script>

<div class="input-bar">
	{#if selectedChannel}
		<span class="channel-label">{selectedChannel}</span>
	{/if}
	<input
		type="text"
		bind:value={text}
		onkeydown={(e) => e.key === 'Enter' && handleSend()}
		placeholder={selectedChannel ? 'Type a message...' : 'Select a channel'}
		disabled={!isConnected}
	/>
	<button onclick={handleSend} disabled={!canSend}>Send</button>
</div>
<div class="action-bar">
	<button class="btn-secondary" onclick={handleRefreshToken} disabled={!isConnected}>
		Refresh Token
	</button>
	<button class="btn-secondary" onclick={handleReplay} disabled={!isConnected}>
		Reconnect with Replay
	</button>
</div>
