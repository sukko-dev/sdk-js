import { useSubscription, useSukkoClient } from "@sukko/react";
import { useEffect, useMemo, useState } from "react";
import type { ChatMessage } from "../utils";
import { createMessageId, decodeTokenPayload } from "../utils";

function SubscribedChannel(props: {
	channel: string;
	active: boolean;
	onSelect: () => void;
	onMessage: (msg: ChatMessage) => void;
	action?: { label: string; onClick: () => void };
}) {
	useSubscription<Record<string, unknown>>({
		channels: [props.channel],
		onMessage: (msg) => {
			const d = msg.data as Record<string, unknown>;
			props.onMessage({
				id: createMessageId(),
				channel: msg.channel,
				sender: (d.sender as string) ?? "unknown",
				text: (d.text as string) ?? JSON.stringify(d),
				ts: msg.ts,
				type: "user",
			});
		},
	});

	return (
		<div
			className={`channel-item ${props.active ? "active" : ""}`}
			onClick={props.onSelect}
			onKeyDown={(e) => e.key === "Enter" && props.onSelect()}
		>
			<span className="channel-name">{props.channel}</span>
			{props.action && (
				<button type="button" onClick={(e) => { e.stopPropagation(); props.action!.onClick(); }}>
					{props.action.label}
				</button>
			)}
		</div>
	);
}

export function ChannelSidebar(props: {
	token: string;
	selectedChannel: string | null;
	onSelectChannel: (channel: string) => void;
	onMessage: (msg: ChatMessage) => void;
}) {
	const client = useSukkoClient();
	const claims = useMemo(() => decodeTokenPayload(props.token), [props.token]);

	const publicChannels = ["all.trade"];
	const userChannels = claims.sub ? [`notifications.${claims.sub}`] : [];
	const availableGroups = claims.groups ?? [];
	const [joinedGroups, setJoinedGroups] = useState<string[]>([]);

	const allSubscribed = [...publicChannels, ...userChannels, ...joinedGroups.map((g) => `community.${g}`)];

	// Auto-select first channel
	useEffect(() => {
		if (!props.selectedChannel && allSubscribed.length > 0) {
			props.onSelectChannel(allSubscribed[0]);
		}
	}, [allSubscribed.length]);

	const handleJoinGroup = (group: string) => {
		if (!joinedGroups.includes(group)) {
			setJoinedGroups((prev) => [...prev, group]);
		}
	};

	const handleLeaveGroup = (group: string) => {
		const channel = `community.${group}`;
		client.unsubscribe([channel]);
		setJoinedGroups((prev) => prev.filter((g) => g !== group));
		if (props.selectedChannel === channel) {
			props.onSelectChannel(allSubscribed[0] ?? "");
		}
	};

	return (
		<div className="channel-sidebar">
			<div className="channel-section">
				<div className="channel-section-title">Public</div>
				{publicChannels.map((ch) => (
					<SubscribedChannel
						key={ch}
						channel={ch}
						active={props.selectedChannel === ch}
						onSelect={() => props.onSelectChannel(ch)}
						onMessage={props.onMessage}
					/>
				))}
			</div>

			{userChannels.length > 0 && (
				<div className="channel-section">
					<div className="channel-section-title">User</div>
					{userChannels.map((ch) => (
						<SubscribedChannel
							key={ch}
							channel={ch}
							active={props.selectedChannel === ch}
							onSelect={() => props.onSelectChannel(ch)}
							onMessage={props.onMessage}
						/>
					))}
				</div>
			)}

			<div className="channel-section">
				<div className="channel-section-title">Groups</div>
				{availableGroups.map((group) => {
					const channel = `community.${group}`;
					const joined = joinedGroups.includes(group);

					if (joined) {
						return (
							<SubscribedChannel
								key={group}
								channel={channel}
								active={props.selectedChannel === channel}
								onSelect={() => props.onSelectChannel(channel)}
								onMessage={props.onMessage}
								action={{ label: "Leave", onClick: () => handleLeaveGroup(group) }}
							/>
						);
					}

					return (
						<div key={group} className="channel-item">
							<span className="channel-name" style={{ color: "#8b949e" }}>
								community.{group}
							</span>
							<button type="button" onClick={() => handleJoinGroup(group)}>
								Join
							</button>
						</div>
					);
				})}
			</div>
		</div>
	);
}
