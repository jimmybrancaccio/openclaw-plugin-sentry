declare module "openclaw/plugin-sdk" {
	export function onDiagnosticEvent<TEvent = unknown>(
		handler: (event: TEvent) => void,
	): () => void;

	export function registerLogTransport<TLog extends Record<string, unknown>>(
		handler: (log: TLog) => void,
	): () => void;
}
