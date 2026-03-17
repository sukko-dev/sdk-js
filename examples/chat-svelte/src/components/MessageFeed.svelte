<script lang="ts">
import { onSukkoEvent } from "@sukko/svelte";
import { tick } from "svelte";
import type { ChatMessage } from "../utils";
import { createMessageId, formatTimestamp } from "../utils";

interface Props {
	messages: ChatMessage[];
	onMessage: (msg: ChatMessage) => void;
}

let { messages, onMessage }: Props = $props();

let listEl: HTMLDivElement;

// Auto-scroll on new messages
$effect(() => {
	messages.length;
	tick().then(() => {
		if (listEl) {
			listEl.scrollTop = listEl.scrollHeight;
		}
	});
});

onSukkoEvent("error", (err) => {
	onMessage({
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Error: ${err.message ?? "Unknown error"}`,
		ts: Date.now(),
		type: "error",
	});
});

onSukkoEvent("publishError", (err) => {
	onMessage({
		id: createMessageId(),
		channel: err.channel ?? "",
		sender: "system",
		text: `Publish error: ${err.message ?? "Failed to publish"}`,
		ts: Date.now(),
		type: "error",
	});
});

onSukkoEvent("subscribeError", (err) => {
	onMessage({
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Subscribe error: ${err.message ?? "Failed to subscribe"}`,
		ts: Date.now(),
		type: "error",
	});
});

onSukkoEvent("stateChange", (state) => {
	onMessage({
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Connection: ${state}`,
		ts: Date.now(),
		type: "system",
	});
});

onSukkoEvent("authAck", () => {
	onMessage({
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: "Token refreshed successfully",
		ts: Date.now(),
		type: "system",
	});
});

onSukkoEvent("authError", (err) => {
	onMessage({
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Auth error: ${err.message ?? "Token refresh failed"}`,
		ts: Date.now(),
		type: "error",
	});
});
</script>

<div class="message-list" bind:this={listEl}>
	{#each messages as msg (msg.id)}
		<div class="message {msg.type}">
			<span class="msg-time">{formatTimestamp(msg.ts)}</span>
			{#if msg.channel}
				<span class="msg-channel">[{msg.channel}]</span>
			{/if}
			<span class="msg-sender">{msg.sender}:</span>
			<span class="msg-text">{msg.text}</span>
		</div>
	{/each}
</div>
