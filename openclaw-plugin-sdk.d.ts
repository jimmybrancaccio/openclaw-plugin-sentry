declare module "openclaw/plugin-sdk/diagnostic-runtime" {
	export function onInternalDiagnosticEvent<TEvent = unknown>(
		handler: (event: TEvent) => void,
	): () => void;
}

declare module "openclaw/plugin-sdk/plugin-entry" {
	export function definePluginEntry<TEntry extends Record<string, unknown>>(
		entry: TEntry,
	): TEntry;
}
