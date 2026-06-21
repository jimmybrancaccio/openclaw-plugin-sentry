import { _INTERNAL_flushLogsBuffer } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

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
	  }
	| {
			type: "log.record";
			level: string;
			message: string;
			loggerName?: string;
			loggerParents?: string[];
			attributes?: Record<string, string | number | boolean>;
			code?: {
				line?: number;
				functionName?: string;
			};
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

type TelemetryStats = {
	diagnosticEvents: number;
	logRecords: number;
	modelUsage: number;
	messageProcessed: number;
	capturedMessages: number;
	spans: number;
	logFlushes: number;
	clientFlushes: number;
	flushErrors: number;
};

export function createSentryService(): OpenClawPluginService {
	let unsubDiag: (() => void) | null = null;
	let telemetryFlushInterval: ReturnType<typeof setInterval> | null = null;
	let flushInFlight = false;
	const stats = createTelemetryStats();

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
			unsubDiag = onInternalDiagnosticEvent((evt: DiagnosticEventPayload) => {
				try {
					stats.diagnosticEvents += 1;
					if (evt.type === "log.record") {
						if (enableLogs) forwardLogRecord(evt, stats);
						return;
					}
					handleDiagnosticEvent(evt, stats);
				} catch {
					// Don't let telemetry errors affect the gateway
				}
			});
			ctx.logger.info("sentry: subscribed to diagnostic events");

			if (enableLogs) {
				ctx.logger.info("sentry: subscribed to diagnostic log records");
			}
			telemetryFlushInterval = setInterval(() => {
				void flushSentryTelemetry(
					ctx,
					stats,
					() => flushInFlight,
					(value) => {
						flushInFlight = value;
					},
				);
			}, 30_000);
			ctx.logger.info("sentry: flushing telemetry every 30s");
		},

		async stop() {
			unsubDiag?.();
			unsubDiag = null;
			if (telemetryFlushInterval) {
				clearInterval(telemetryFlushInterval);
				telemetryFlushInterval = null;
			}
			flushSentryLogs();
			await Sentry.flush(5000).catch((): undefined => undefined);
		},
	};
}

// ── Diagnostic events → spans / messages ────────────────────

function handleDiagnosticEvent(
	evt: DiagnosticEventPayload,
	stats: TelemetryStats,
): void {
	switch (evt.type) {
		case "model.usage":
			stats.modelUsage += 1;
			recordModelUsage(evt, stats);
			return;
		case "message.processed":
			stats.messageProcessed += 1;
			recordMessageProcessed(evt, stats);
			return;
		case "webhook.error":
			Sentry.captureMessage(`Webhook error: ${evt.error}`, {
				level: "error",
				tags: { channel: evt.channel, updateType: evt.updateType },
			});
			stats.capturedMessages += 1;
			return;
		case "session.stuck":
			Sentry.captureMessage(
				`Session stuck: ${evt.sessionKey} (${evt.ageMs}ms)`,
				{
					level: "warning",
					tags: { sessionKey: evt.sessionKey, state: evt.state },
				},
			);
			stats.capturedMessages += 1;
			return;
		case "log.record":
			return;
		// Silently ignore event types we don't handle (webhook.received,
		// session.state, queue.lane.*, diagnostic.heartbeat, etc.)
	}
}

// ── Model usage → ai.chat span with real duration ───────────

function recordModelUsage(
	evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
	stats: TelemetryStats,
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
	if (span?.isRecording()) {
		stats.spans += 1;
	}
}

// ── Message processed → openclaw.message span ───────────────

function recordMessageProcessed(
	evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
	stats: TelemetryStats,
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
				stats.capturedMessages += 1;
			}
		}
		span.end(endTimeMs);
		if (span.isRecording()) {
			stats.spans += 1;
		}
	}
}

// ── Diagnostic log records → Sentry structured logs ──────────

function forwardLogRecord(
	evt: Extract<DiagnosticEventPayload, { type: "log.record" }>,
	stats: TelemetryStats,
): void {
	const loggerApi = Sentry.logger;
	if (!loggerApi) return;
	stats.logRecords += 1;

	const attrs: Record<string, string | number | boolean> = {
		...evt.attributes,
	};

	if (evt.loggerName) {
		attrs["openclaw.logger"] = evt.loggerName;
	}
	if (evt.loggerParents?.length) {
		attrs["openclaw.logger_parents"] = evt.loggerParents.join(".");
	}
	if (evt.code?.line !== undefined) {
		attrs["code.line"] = evt.code.line;
	}
	if (evt.code?.functionName) {
		attrs["code.function"] = evt.code.functionName;
	}

	switch (evt.level.toLowerCase()) {
		case "debug":
			loggerApi.debug(evt.message, attrs);
			return;
		case "trace":
			loggerApi.trace(evt.message, attrs);
			return;
		case "warn":
		case "warning":
			loggerApi.warn(evt.message, attrs);
			return;
		case "error":
			loggerApi.error(evt.message, attrs);
			return;
		case "fatal":
			loggerApi.fatal(evt.message, attrs);
			return;
		default:
			loggerApi.info(evt.message, attrs);
	}
}

function flushSentryLogs(): void {
	const client = Sentry.getClient();
	if (client) {
		_INTERNAL_flushLogsBuffer(client);
	}
}

async function flushSentryTelemetry(
	ctx: OpenClawPluginContext,
	stats: TelemetryStats,
	getFlushInFlight: () => boolean,
	setFlushInFlight: (value: boolean) => void,
): Promise<void> {
	if (getFlushInFlight()) return;
	setFlushInFlight(true);
	try {
		flushSentryLogs();
		stats.logFlushes += 1;
		await Sentry.flush(5000);
		stats.clientFlushes += 1;
		ctx.logger.info(formatTelemetryStats(stats));
	} catch {
		stats.flushErrors += 1;
		ctx.logger.warn(formatTelemetryStats(stats));
	} finally {
		setFlushInFlight(false);
	}
}

function createTelemetryStats(): TelemetryStats {
	return {
		diagnosticEvents: 0,
		logRecords: 0,
		modelUsage: 0,
		messageProcessed: 0,
		capturedMessages: 0,
		spans: 0,
		logFlushes: 0,
		clientFlushes: 0,
		flushErrors: 0,
	};
}

function formatTelemetryStats(stats: TelemetryStats): string {
	return `sentry: telemetry stats events=${stats.diagnosticEvents} logs=${stats.logRecords} modelUsage=${stats.modelUsage} messageProcessed=${stats.messageProcessed} messages=${stats.capturedMessages} spans=${stats.spans} logFlushes=${stats.logFlushes} clientFlushes=${stats.clientFlushes} flushErrors=${stats.flushErrors}`;
}

// ── Plugin entry point ──────────────────────────────────────

export default definePluginEntry({
	id: "sentry",
	name: "Sentry",
	description:
		"Send errors, logs, and traces from your OpenClaw instance to Sentry",
	kind: "service",
	register(api: OpenClawPluginApi) {
		api.registerService(createSentryService());
	},
});
