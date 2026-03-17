import { SukkoClient } from "@sukko/sdk";
import type { SukkoClientOptions } from "@sukko/sdk";
import {
	type InjectionKey,
	type Plugin,
	type Ref,
	defineComponent,
	h,
	inject,
	onMounted,
	onUnmounted,
	provide,
	ref,
} from "vue";

const SUKKO_KEY: InjectionKey<SukkoClient> = Symbol("sukko");

export interface SukkoProviderProps {
	/** Pre-built client instance (takes precedence over options). */
	client?: SukkoClient;
	/** Options to create a new client. Ignored if `client` is provided. */
	options?: SukkoClientOptions;
}

/**
 * Provides a SukkoClient to the component tree via Vue's provide/inject.
 *
 * Either pass a pre-built `client` or `options` to create one automatically.
 * Auto-created clients connect on mount and disconnect on unmount.
 *
 * ```vue
 * <SukkoProvider :options="{ transport, token }">
 *   <App />
 * </SukkoProvider>
 * ```
 */
export const SukkoProvider = defineComponent({
	name: "SukkoProvider",
	props: {
		client: { type: Object as () => SukkoClient, default: undefined },
		options: { type: Object as () => SukkoClientOptions, default: undefined },
	},
	setup(props, { slots }) {
		const resolvedClient: Ref<SukkoClient | null> = ref(null);
		const isOwned = ref(false);

		if (props.client) {
			resolvedClient.value = props.client;
			isOwned.value = false;
		} else if (props.options) {
			resolvedClient.value = new SukkoClient({ ...props.options, autoConnect: false });
			isOwned.value = true;
		}

		if (resolvedClient.value) {
			provide(SUKKO_KEY, resolvedClient.value);
		}

		onMounted(() => {
			const c = resolvedClient.value;
			if (c && isOwned.value && c.state === "disconnected") {
				c.connect();
			}
		});

		onUnmounted(() => {
			if (isOwned.value && resolvedClient.value) {
				resolvedClient.value.disconnect();
			}
		});

		return () => slots.default?.();
	},
});

export interface SukkoPluginOptions {
	/** Pre-built client instance. */
	client?: SukkoClient;
	/** Options to create a new client. Ignored if `client` is provided. */
	options?: SukkoClientOptions;
}

/**
 * Vue plugin that provides a SukkoClient at the app level.
 *
 * ```ts
 * const app = createApp(App);
 * app.use(createSukkoPlugin({ options: { transport, token } }));
 * ```
 */
export function createSukkoPlugin(pluginOptions: SukkoPluginOptions): Plugin {
	return {
		install(app) {
			if (!pluginOptions.client && !pluginOptions.options) {
				throw new Error("createSukkoPlugin requires either a 'client' or 'options'");
			}
			const client =
				pluginOptions.client ??
				new SukkoClient({ ...pluginOptions.options!, autoConnect: false });
			app.provide(SUKKO_KEY, client);
		},
	};
}

/**
 * Access the SukkoClient from context.
 * Throws if used outside of `<SukkoProvider>` or `createSukkoPlugin`.
 */
export function useSukkoClient(): SukkoClient {
	const client = inject(SUKKO_KEY);
	if (!client) {
		throw new Error(
			"useSukkoClient must be used within a <SukkoProvider> or app.use(createSukkoPlugin(...))",
		);
	}
	return client;
}
