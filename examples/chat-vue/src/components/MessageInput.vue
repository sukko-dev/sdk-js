<script setup lang="ts">
import { useConnectionState, useSukkoClient } from "@sukko/vue";
import { computed, ref } from "vue";
import type { ChatMessage } from "../utils";
import { createMessageId, decodeTokenPayload } from "../utils";

const props = defineProps<{
	token: string;
	selectedChannel: string | null;
}>();

const emit = defineEmits<{
	message: [msg: ChatMessage];
}>();

const client = useSukkoClient();
const { isConnected } = useConnectionState();
const text = ref("");

const canSend = computed(() => isConnected.value && !!props.selectedChannel && text.value.trim().length > 0);

function handleSend() {
	if (!canSend.value || !props.selectedChannel) return;

	const claims = decodeTokenPayload(props.token);
	const sender = claims.sub ?? "anonymous";

	client.publish(props.selectedChannel, {
		sender,
		text: text.value.trim(),
		ts: Date.now(),
	});

	emit("message", {
		id: createMessageId(),
		channel: props.selectedChannel,
		sender,
		text: text.value.trim(),
		ts: Date.now(),
		type: "user",
	});

	text.value = "";
}

function handleRefreshToken() {
	const newToken = prompt("Enter new JWT token:");
	if (newToken) {
		client.updateToken(newToken);
		emit("message", {
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
	emit("message", {
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: "Reconnect with replay requested.",
		ts: Date.now(),
		type: "system",
	});
}
</script>

<template>
	<div class="input-bar">
		<span v-if="selectedChannel" class="channel-label">{{ selectedChannel }}</span>
		<input
			type="text"
			v-model="text"
			@keydown.enter="handleSend"
			:placeholder="selectedChannel ? 'Type a message...' : 'Select a channel'"
			:disabled="!isConnected"
		/>
		<button @click="handleSend" :disabled="!canSend">Send</button>
	</div>
	<div class="action-bar">
		<button class="btn-secondary" @click="handleRefreshToken" :disabled="!isConnected">
			Refresh Token
		</button>
		<button class="btn-secondary" @click="handleReplay" :disabled="!isConnected">
			Reconnect with Replay
		</button>
	</div>
</template>
