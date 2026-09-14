<script setup lang="ts">
import { useConnectionState } from "@sukko/vue";

const { state } = useConnectionState();
</script>

<template>
	<div class="status-indicator">
		<span :class="['status-dot', state]" />
		<span>{{ state }}</span>
	</div>
</template>
