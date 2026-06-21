declare module "openclaw/plugin-sdk/diagnostic-runtime" {
	export function onDiagnosticEvent<TEvent = unknown>(
		handler: (event: TEvent) => void,
	): () => void;
}
