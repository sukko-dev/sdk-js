<script setup lang="ts">
import { useSubscription, useSukkoClient } from "@sukko/vue";
import { computed, ref, watch } from "vue";
import type { ChatMessage } from "../utils";
import { createMessageId, decodeTokenPayload } from "../utils";

const props = defineProps<{
	token: string;
	selectedChannel: string | null;
}>();

const emit = defineEmits<{
	selectChannel: [channel: string];
	message: [msg: ChatMessage];
}>();

const client = useSukkoClient();
const claims = computed(() => decodeTokenPayload(props.token));

const publicChannels = ["all.trade"];
const userChannels = computed(() =>
	claims.value.sub ? [`notifications.${claims.value.sub}`] : [],
);
const availableGroups = computed(() => claims.value.groups ?? []);
const joinedGroups = ref<string[]>([]);
const groupChannels = computed(() => joinedGroups.value.map((g) => `community.${g}`));

const allSubscribed = computed(() => [
	...publicChannels,
	...userChannels.value,
	...groupChannels.value,
]);

// Subscribe to all active channels
const { lastMessage } = useSubscription<Record<string, unknown>>({
	channels: allSubscribed,
	onMessage: (msg) => {
		const d = msg.data as Record<string, unknown>;
		emit("message", {
			id: createMessageId(),
			channel: msg.channel,
			sender: (d.sender as string) ?? "unknown",
			text: (d.text as string) ?? JSON.stringify(d),
			ts: msg.ts,
			type: "user",
		});
	},
});

// Auto-select first channel
watch(allSubscribed, (channels) => {
	if (!props.selectedChannel && channels.length > 0) {
		emit("selectChannel", channels[0]);
	}
}, { immediate: true });

function joinGroup(group: string) {
	if (!joinedGroups.value.includes(group)) {
		joinedGroups.value = [...joinedGroups.value, group];
	}
}

function leaveGroup(group: string) {
	const channel = `community.${group}`;
	client.unsubscribe([channel]);
	joinedGroups.value = joinedGroups.value.filter((g) => g !== group);
	if (props.selectedChannel === channel) {
		emit("selectChannel", allSubscribed.value[0] ?? "");
	}
}
</script>

<template>
	<div class="channel-sidebar">
		<div class="channel-section">
			<div class="channel-section-title">Public</div>
			<div
				v-for="ch in publicChannels"
				:key="ch"
				:class="['channel-item', { active: selectedChannel === ch }]"
				@click="emit('selectChannel', ch)"
			>
				<span class="channel-name">{{ ch }}</span>
			</div>
		</div>

		<div v-if="userChannels.length > 0" class="channel-section">
			<div class="channel-section-title">User</div>
			<div
				v-for="ch in userChannels"
				:key="ch"
				:class="['channel-item', { active: selectedChannel === ch }]"
				@click="emit('selectChannel', ch)"
			>
				<span class="channel-name">{{ ch }}</span>
			</div>
		</div>

		<div class="channel-section">
			<div class="channel-section-title">Groups</div>
			<div v-for="group in availableGroups" :key="group">
				<div v-if="joinedGroups.includes(group)"
					:class="['channel-item', { active: selectedChannel === `community.${group}` }]"
				>
					<span class="channel-name" @click="emit('selectChannel', `community.${group}`)">
						community.{{ group }}
					</span>
					<button @click="leaveGroup(group)">Leave</button>
				</div>
				<div v-else class="channel-item">
					<span class="channel-name" style="color: #8b949e">community.{{ group }}</span>
					<button @click="joinGroup(group)">Join</button>
				</div>
			</div>
		</div>
	</div>
</template>
