<script lang="ts">
import type { DataMessage } from "@sukko/sdk";
import { getSukkoClient } from "@sukko/svelte";
import type { ChatMessage } from "../utils";
import { createMessageId, decodeTokenPayload } from "../utils";

interface Props {
	token: string;
	selectedChannel: string | null;
	onSelectChannel: (channel: string) => void;
	onMessage: (msg: ChatMessage) => void;
}

const { token, selectedChannel, onSelectChannel, onMessage }: Props = $props();

const client = getSukkoClient();
let joinedGroups = $state<string[]>([]);

const claims = $derived(decodeTokenPayload(token));
const tenant = $derived(claims.tenant_id ?? "sukko");
const publicChannels = $derived([`${tenant}.general.messages`]);
const userChannels = $derived(claims.sub ? [`${tenant}.inbox.${claims.sub}`] : []);
const groupChannels = $derived(joinedGroups.map((g) => `${tenant}.rooms.${g}`));
const allSubscribed = $derived([...publicChannels, ...userChannels, ...groupChannels]);

// Manage subscriptions reactively via $effect
$effect(() => {
	const channels = allSubscribed;
	if (channels.length === 0) return;

	client.subscribe(channels);

	const off = client.on("message", (msg: DataMessage) => {
		if (channels.includes(msg.channel)) {
			const d = msg.data as Record<string, unknown>;
			onMessage({
				id: createMessageId(),
				channel: msg.channel,
				sender: (d.sender as string) ?? "unknown",
				text: (d.text as string) ?? JSON.stringify(d),
				ts: msg.ts,
				type: "user",
			});
		}
	});

	return () => {
		off();
		client.unsubscribe(channels);
	};
});

// Auto-select first channel
$effect(() => {
	if (!selectedChannel && allSubscribed.length > 0) {
		onSelectChannel(allSubscribed[0]);
	}
});

function joinGroup(group: string) {
	if (!joinedGroups.includes(group)) {
		joinedGroups = [...joinedGroups, group];
	}
}

function leaveGroup(group: string) {
	joinedGroups = joinedGroups.filter((g) => g !== group);
	if (selectedChannel === `${tenant}.rooms.${group}`) {
		onSelectChannel(allSubscribed[0] ?? "");
	}
}
</script>

<div class="channel-sidebar">
	<div class="channel-section">
		<div class="channel-section-title">Public</div>
		{#each publicChannels as ch}
			<div
				class="channel-item {selectedChannel === ch ? 'active' : ''}"
				onclick={() => onSelectChannel(ch)}
				role="button"
				tabindex="0"
				onkeydown={(e) => e.key === 'Enter' && onSelectChannel(ch)}
			>
				<span class="channel-name">{ch}</span>
			</div>
		{/each}
	</div>

	{#if userChannels.length > 0}
		<div class="channel-section">
			<div class="channel-section-title">User</div>
			{#each userChannels as ch}
				<div
					class="channel-item {selectedChannel === ch ? 'active' : ''}"
					onclick={() => onSelectChannel(ch)}
					role="button"
					tabindex="0"
					onkeydown={(e) => e.key === 'Enter' && onSelectChannel(ch)}
				>
					<span class="channel-name">{ch}</span>
				</div>
			{/each}
		</div>
	{/if}

	<div class="channel-section">
		<div class="channel-section-title">Groups</div>
		{#each claims.groups ?? [] as group}
			{#if joinedGroups.includes(group)}
				<div class="channel-item {selectedChannel === `${tenant}.rooms.${group}` ? 'active' : ''}">
					<span
						class="channel-name"
						onclick={() => onSelectChannel(`${tenant}.rooms.${group}`)}
						role="button"
						tabindex="0"
						onkeydown={(e) => e.key === 'Enter' && onSelectChannel(`${tenant}.rooms.${group}`)}
					>
						{tenant}.rooms.{group}
					</span>
					<button onclick={() => leaveGroup(group)}>Leave</button>
				</div>
			{:else}
				<div class="channel-item">
					<span class="channel-name" style="color: #8b949e">{tenant}.rooms.{group}</span>
					<button onclick={() => joinGroup(group)}>Join</button>
				</div>
			{/if}
		{/each}
	</div>
</div>
