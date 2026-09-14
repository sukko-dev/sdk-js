<script lang="ts">
import type { SukkoClient } from "@sukko/sdk";
import { createConnectionState, setSukkoClient } from "@sukko/svelte";
import type { ChatMessage } from "../utils";

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

const {
	client,
	wsUrl,
	token,
	messages,
	selectedChannel,
	onWsUrlChange,
	onTokenChange,
	onConnect,
	onDisconnect,
	onSelectChannel,
	onMessage,
}: Props = $props();

// Set context during component initialization — this is the correct place
setSukkoClient(client);

// Now we can safely use context-dependent stores
const connectionStore = createConnectionState();
let _connectionState = $state("disconnected");

const _unsubConnection = connectionStore.subscribe((v) => {
	_connectionState = v.state;
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
