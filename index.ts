import * as Sentry from "@sentry/node";
import { onDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";

type DiagnosticEventPayload =
	| {
			type: "model.usage";
			ts: number;
			durationMs?: number;
			provider?: string;
			model?: string;
			channel?: string;
			sessionKey?: string;
			costUsd?: number;
			usage: {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				total?: number;
			};
	  }
	| {
			type: "message.processed";
			ts: number;
			durationMs?: number;
			outcome: string;
			error?: string;
			channel: string;
			sessionKey?: string;
			chatId?: string | number;
			messageId?: string | number;
	  }
	| {
			type: "webhook.error";
			error: string;
			channel: string;
			updateType: string;
	  }
	| {
			type: "session.stuck";
			sessionKey: string;
			ageMs: number;
			state: string;
	  };

type OpenClawPluginContext = {
	logger: {
		info(message: string): void;
		warn(message: string): void;
	};
	config: {
		plugins?: {
			entries?: Record<string, { config?: Record<string, unknown> }>;
		};
	};
};

type OpenClawPluginService = {
	id: string;
	start(ctx: OpenClawPluginContext): Promise<void> | void;
	stop(): Promise<void> | void;
};

type OpenClawPluginApi = {
	registerService(service: OpenClawPluginService): void;
};

export function createSentryService(): OpenClawPluginService {
	let unsubDiag: (() => void) | null = null;

	return {
		id: "sentry",

		async start(ctx) {
			ctx.logger.info("sentry: start() entered");
			const entries = ctx.config.plugins?.entries as
				| Record<string, { config?: Record<string, unknown> }>
				| undefined;
			const pluginCfg = entries?.sentry?.config as
				| {
						dsn?: string;
						environment?: string;
						tracesSampleRate?: number;
						enableLogs?: boolean;
				  }
				| undefined;
			const dsn = pluginCfg?.dsn;

			if (!dsn) {
				ctx.logger.warn("sentry: no DSN configured — skipping init");
				return;
			}

			// ── 1. Init Sentry SDK ──────────────────────────────────
			const enableLogs = pluginCfg?.enableLogs !== false; // default true
			Sentry.init({
				dsn,
				environment: pluginCfg?.environment ?? "production",
				tracesSampleRate: pluginCfg?.tracesSampleRate ?? 1.0,
				enableLogs, // top-level in Sentry SDK v10+
			});

			ctx.logger.info(
				`sentry: initialized (dsn=...${dsn.slice(-12)}, env=${pluginCfg?.environment ?? "production"}, logs=${enableLogs})`,
			);

			// ── 2. Diagnostic events → Sentry spans + messages ─────
			unsubDiag = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
				try {
					handleDiagnosticEvent(evt);
				} catch {
					// Don't let telemetry errors affect the gateway
				}
			});
			ctx.logger.info("sentry: subscribed to diagnostic events");

			if (enableLogs) {
				ctx.logger.info(
					"sentry: structured log forwarding skipped; this OpenClaw runtime does not expose a plugin log transport",
				);
			}
		},

		async stop() {
			unsubDiag?.();
			unsubDiag = null;
			await Sentry.flush(5000).catch((): undefined => undefined);
		},
	};
}

// ── Diagnostic events → spans / messages ────────────────────

function handleDiagnosticEvent(evt: DiagnosticEventPayload): void {
	switch (evt.type) {
		case "model.usage":
			recordModelUsage(evt);
			return;
		case "message.processed":
			recordMessageProcessed(evt);
			return;
		case "webhook.error":
			Sentry.captureMessage(`Webhook error: ${evt.error}`, {
				level: "error",
				tags: { channel: evt.channel, updateType: evt.updateType },
			});
			return;
		case "session.stuck":
			Sentry.captureMessage(
				`Session stuck: ${evt.sessionKey} (${evt.ageMs}ms)`,
				{
					level: "warning",
					tags: { sessionKey: evt.sessionKey, state: evt.state },
				},
			);
			return;
		// Silently ignore event types we don't handle (webhook.received,
		// session.state, queue.lane.*, diagnostic.heartbeat, etc.)
	}
}

// ── Model usage → ai.chat span with real duration ───────────

function recordModelUsage(
	evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
): void {
	const spanName = evt.model ? `chat ${evt.model}` : "chat unknown";
	const endTimeMs = evt.ts;
	const durationMs = evt.durationMs ?? 100;
	const startTimeMs = endTimeMs - durationMs;

	// startInactiveSpan with explicit timestamps (Sentry v10 accepts ms)
	const span = Sentry.startInactiveSpan({
		op: "ai.chat",
		name: spanName,
		startTime: startTimeMs,
		forceTransaction: true,
		attributes: {
			// GenAI semantic conventions (OpenTelemetry)
			"gen_ai.operation.name": "chat",
			"gen_ai.system": evt.provider ?? "unknown",
			"gen_ai.request.model": evt.model ?? "unknown",
			"gen_ai.usage.input_tokens": evt.usage.input ?? 0,
			"gen_ai.usage.output_tokens": evt.usage.output ?? 0,
			// OpenClaw context
			"openclaw.channel": evt.channel ?? "unknown",
			"openclaw.session_key": evt.sessionKey ?? "unknown",
			"openclaw.tokens.cache_read": evt.usage.cacheRead ?? 0,
			"openclaw.tokens.cache_write": evt.usage.cacheWrite ?? 0,
			"openclaw.tokens.total": evt.usage.total ?? 0,
			"openclaw.cost_usd": evt.costUsd ?? 0,
			"openclaw.duration_ms": durationMs,
		},
	});

	span?.end(endTimeMs);
}

// ── Message processed → openclaw.message span ───────────────

function recordMessageProcessed(
	evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
): void {
	const endTimeMs = evt.ts;
	const durationMs = evt.durationMs ?? 50;
	const startTimeMs = endTimeMs - durationMs;

	const span = Sentry.startInactiveSpan({
		op: "openclaw.message",
		name: `message.${evt.outcome}`,
		startTime: startTimeMs,
		forceTransaction: true,
		attributes: {
			"openclaw.channel": evt.channel,
			"openclaw.outcome": evt.outcome,
			"openclaw.session_key": evt.sessionKey ?? "unknown",
			"openclaw.chat_id": String(evt.chatId ?? ""),
			"openclaw.message_id": String(evt.messageId ?? ""),
			"openclaw.duration_ms": durationMs,
		},
	});

	if (span) {
		if (evt.outcome === "error") {
			span.setStatus({ code: 2, message: evt.error ?? "unknown error" });
			if (evt.error) {
				Sentry.captureMessage(`Message processing error: ${evt.error}`, {
					level: "error",
					tags: { channel: evt.channel, sessionKey: evt.sessionKey },
				});
			}
		}
		span.end(endTimeMs);
	}
}

// ── Plugin entry point ──────────────────────────────────────

export default function register(api: OpenClawPluginApi) {
	api.registerService(createSentryService());
}
