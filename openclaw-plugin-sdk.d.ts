declare module "openclaw/plugin-sdk/diagnostic-runtime" {
	export function onInternalDiagnosticEvent<TEvent = unknown>(
		handler: (event: TEvent) => void,
	): () => void;
}
