<script setup lang="ts">
import { SukkoClient } from "@sukko/sdk";
import { SukkoProvider } from "@sukko/vue";
import { WebSocketTransport } from "@sukko/websocket";
import { ref, shallowRef } from "vue";
import type { ChatMessage } from "./utils";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import ChannelSidebar from "./components/ChannelSidebar.vue";
import MessageFeed from "./components/MessageFeed.vue";
import MessageInput from "./components/MessageInput.vue";

const wsUrl = ref("ws://localhost:3000/ws");
const token = ref("");
const client = shallowRef<SukkoClient | null>(null);
const messages = ref<ChatMessage[]>([]);
const selectedChannel = ref<string | null>(null);

function addMessage(msg: ChatMessage) {
	messages.value = [...messages.value, msg].slice(-200);
}

function handleConnect() {
	if (client.value) {
		client.value.disconnect();
	}

	const transport = new WebSocketTransport({ url: wsUrl.value });
	const newClient = new SukkoClient({
		transport,
		token: token.value,
		autoConnect: false,
		reconnect: true,
	});

	client.value = newClient;
	newClient.connect();
}

function handleDisconnect() {
	if (client.value) {
		client.value.disconnect();
		client.value = null;
	}
}
</script>

<template>
	<SukkoProvider v-if="client" :client="client">
		<ConnectionPanel
			:ws-url="wsUrl"
			:token="token"
			:connected="true"
			@update:ws-url="wsUrl = $event"
			@update:token="token = $event"
			@connect="handleConnect"
			@disconnect="handleDisconnect"
		/>
		<div class="main-layout">
			<ChannelSidebar
				:token="token"
				:selected-channel="selectedChannel"
				@select-channel="selectedChannel = $event"
				@message="addMessage"
			/>
			<div class="message-feed">
				<MessageFeed :messages="messages" @message="addMessage" />
				<MessageInput
					:token="token"
					:selected-channel="selectedChannel"
					@message="addMessage"
				/>
			</div>
		</div>
	</SukkoProvider>
	<template v-else>
		<ConnectionPanel
			:ws-url="wsUrl"
			:token="token"
			:connected="false"
			@update:ws-url="wsUrl = $event"
			@update:token="token = $event"
			@connect="handleConnect"
			@disconnect="handleDisconnect"
		/>
		<div class="main-layout">
			<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: #8b949e">
				Enter a WebSocket URL and token, then click Connect.
			</div>
		</div>
	</template>
</template>
