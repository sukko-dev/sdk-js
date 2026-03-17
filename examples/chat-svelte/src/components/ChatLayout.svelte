<script lang="ts">
import type { SukkoClient } from "@sukko/sdk";
import { setSukkoClient, createConnectionState } from "@sukko/svelte";
import type { ChatMessage } from "../utils";
import ConnectionPanel from "./ConnectionPanel.svelte";
import ChannelSidebar from "./ChannelSidebar.svelte";
import MessageFeed from "./MessageFeed.svelte";
import MessageInput from "./MessageInput.svelte";

interface Props {
	client: SukkoClient;
	wsUrl: string;
	token: string;
	messages: ChatMessage[];
	selectedChannel: string | null;
	onWsUrlChange: (url: string) => void;
	onTokenChange: (token: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onSelectChannel: (channel: string) => void;
	onMessage: (msg: ChatMessage) => void;
}

let {
	client, wsUrl, token, messages, selectedChannel,
	onWsUrlChange, onTokenChange, onConnect, onDisconnect,
	onSelectChannel, onMessage,
}: Props = $props();

// Set context during component initialization — this is the correct place
setSukkoClient(client);

// Now we can safely use context-dependent stores
const connectionStore = createConnectionState();
let connectionState = $state("disconnected");

const unsubConnection = connectionStore.subscribe((v) => {
	connectionState = v.state;
});
</script>

<ConnectionPanel
	{wsUrl}
	{token}
	connected={true}
	{connectionState}
	{onWsUrlChange}
	{onTokenChange}
	{onConnect}
	{onDisconnect}
/>
<div class="main-layout">
	<ChannelSidebar
		{token}
		{selectedChannel}
		{onSelectChannel}
		{onMessage}
	/>
	<div class="message-feed">
		<MessageFeed {messages} {onMessage} />
		<MessageInput
			{token}
			{selectedChannel}
			{onMessage}
		/>
	</div>
</div>
