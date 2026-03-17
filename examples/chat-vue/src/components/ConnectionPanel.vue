<script setup lang="ts">
import StatusIndicator from "./StatusIndicator.vue";

const props = defineProps<{
	wsUrl: string;
	token: string;
	connected: boolean;
}>();

const emit = defineEmits<{
	"update:wsUrl": [url: string];
	"update:token": [token: string];
	connect: [];
	disconnect: [];
}>();
</script>

<template>
	<div class="connection-bar">
		<input
			type="text"
			:value="props.wsUrl"
			@input="emit('update:wsUrl', ($event.target as HTMLInputElement).value)"
			placeholder="ws://localhost:3000/ws"
			:disabled="props.connected"
		/>
		<textarea
			:value="props.token"
			@input="emit('update:token', ($event.target as HTMLTextAreaElement).value)"
			placeholder="Paste JWT token..."
			:disabled="props.connected"
		/>
		<button v-if="props.connected" class="btn-disconnect" @click="emit('disconnect')">
			Disconnect
		</button>
		<button v-else class="btn-connect" :disabled="!props.token" @click="emit('connect')">
			Connect
		</button>
		<StatusIndicator v-if="props.connected" />
	</div>
</template>
