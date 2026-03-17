<script setup lang="ts">
import { useSukkoEvent } from "@sukko/vue";
import { nextTick, ref, watch } from "vue";
import type { ChatMessage } from "../utils";
import { createMessageId, formatTimestamp } from "../utils";

const props = defineProps<{
	messages: ChatMessage[];
}>();

const emit = defineEmits<{
	message: [msg: ChatMessage];
}>();

const listRef = ref<HTMLDivElement>();

// Auto-scroll on new messages
watch(() => props.messages.length, async () => {
	await nextTick();
	if (listRef.value) {
		listRef.value.scrollTop = listRef.value.scrollHeight;
	}
});

useSukkoEvent("error", (err) => {
	emit("message", {
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Error: ${err.message ?? "Unknown error"}`,
		ts: Date.now(),
		type: "error",
	});
});

useSukkoEvent("publishError", (err) => {
	emit("message", {
		id: createMessageId(),
		channel: err.channel ?? "",
		sender: "system",
		text: `Publish error: ${err.message ?? "Failed to publish"}`,
		ts: Date.now(),
		type: "error",
	});
});

useSukkoEvent("subscribeError", (err) => {
	emit("message", {
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Subscribe error: ${err.message ?? "Failed to subscribe"}`,
		ts: Date.now(),
		type: "error",
	});
});

useSukkoEvent("stateChange", (state) => {
	emit("message", {
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Connection: ${state}`,
		ts: Date.now(),
		type: "system",
	});
});

useSukkoEvent("authAck", () => {
	emit("message", {
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: "Token refreshed successfully",
		ts: Date.now(),
		type: "system",
	});
});

useSukkoEvent("authError", (err) => {
	emit("message", {
		id: createMessageId(),
		channel: "",
		sender: "system",
		text: `Auth error: ${err.message ?? "Token refresh failed"}`,
		ts: Date.now(),
		type: "error",
	});
});
</script>

<template>
	<div class="message-list" ref="listRef">
		<div v-for="msg in messages" :key="msg.id" :class="['message', msg.type]">
			<span class="msg-time">{{ formatTimestamp(msg.ts) }}</span>
			<span v-if="msg.channel" class="msg-channel">[{{ msg.channel }}]</span>
			<span class="msg-sender">{{ msg.sender }}:</span>
			<span class="msg-text">{{ msg.text }}</span>
		</div>
	</div>
</template>
