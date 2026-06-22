import { _INTERNAL_flushLogsBuffer } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type DiagnosticEventPayload =
	| {
			type: "model.usage";
			ts: number;
			trace?: DiagnosticTraceContext;
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
			trace?: DiagnosticTraceContext;
			durationMs?: number;
			outcome: string;
			error?: string;
			channel: string;
			sessionKey?: string;
			chatId?: string | number;
			messageId?: string | number;
	  }
	| {
			type: "model.call.completed";
			ts: number;
			trace?: DiagnosticTraceContext;
			durationMs?: number;
			provider?: string;
			model?: string;
			channel?: string;
			sessionKey?: string;
			requestPayloadBytes?: number;
			responseStreamBytes?: number;
			timeToFirstByteMs?: number;
	  }
	| {
			type: "model.call.error";
			ts: number;
			trace?: DiagnosticTraceContext;
			durationMs?: number;
			provider?: string;
			model?: string;
			channel?: string;
			sessionKey?: string;
			requestPayloadBytes?: number;
			responseStreamBytes?: number;
			timeToFirstByteMs?: number;
			errorCategory?: string;
			failureKind?: string;
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

type ModelCallEndedHookEvent = {
	runId: string;
	callId: string;
	sessionKey?: string;
	sessionId?: string;
	provider: string;
	model: string;
	durationMs: number;
	outcome: "completed" | "error";
	errorCategory?: string;
	failureKind?: string;
	requestPayloadBytes?: number;
	responseStreamBytes?: number;
	timeToFirstByteMs?: number;
};

type PluginHookAgentContext = {
	trace?: DiagnosticTraceContext;
	channel?: string;
	sessionKey?: string;
	sessionId?: string;
};

type DiagnosticTraceContext = {
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	traceFlags?: string;
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
	registrationMode?: string;
	logger?: {
		info(message: string): void;
		warn(message: string): void;
	};
	registerService(service: OpenClawPluginService): void;
	on?(
		hookName: "model_call_ended",
		handler: (
			event: ModelCallEndedHookEvent,
			ctx: PluginHookAgentContext,
		) => Promise<void> | void,
		opts?: { priority?: number; timeoutMs?: number },
	): void;
};

export function createSentryService(): OpenClawPluginService {
	let unsubDiag: (() => void) | null = null;
	let telemetryFlushInterval: ReturnType<typeof setInterval> | null = null;
	let flushInFlight = false;

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
					if (evt.type === "log.record") {
						if (enableLogs) forwardLogRecord(evt);
						return;
					}
					handleDiagnosticEvent(evt);
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

function handleDiagnosticEvent(evt: DiagnosticEventPayload): void {
	switch (evt.type) {
		case "model.usage":
			recordModelUsage(evt);
			return;
		case "message.processed":
			recordMessageProcessed(evt);
			return;
		case "model.call.completed":
			recordModelCall(evt);
			return;
		case "model.call.error":
			recordModelCall(evt);
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
		case "log.record":
			return;
		// Silently ignore event types we don't handle (webhook.received,
		// session.state, queue.lane.*, diagnostic.heartbeat, etc.)
	}
}

// ── Model usage → ai.chat span with real duration ───────────

function recordModelUsage(
	evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
): void {
	withDiagnosticTrace(evt.trace, () => {
		recordModelUsageSpan(evt);
	});
}

function recordModelUsageSpan(
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

// ── Model call lifecycle → ai.chat transaction ──────────────

function recordModelCall(
	evt: Extract<
		DiagnosticEventPayload,
		{ type: "model.call.completed" | "model.call.error" }
	>,
): void {
	withDiagnosticTrace(evt.trace, () => {
		recordModelCallSpan(evt);
	});
}

function recordModelCallSpan(
	evt: Extract<
		DiagnosticEventPayload,
		{ type: "model.call.completed" | "model.call.error" }
	>,
): void {
	const spanName = evt.model ? `model call ${evt.model}` : "model call unknown";
	const endTimeMs = evt.ts;
	const durationMs = evt.durationMs ?? 100;
	const startTimeMs = endTimeMs - durationMs;

	const span = Sentry.startInactiveSpan({
		op: "ai.chat",
		name: spanName,
		startTime: startTimeMs,
		forceTransaction: true,
		attributes: {
			"gen_ai.operation.name": "chat",
			"gen_ai.system": evt.provider ?? "unknown",
			"gen_ai.request.model": evt.model ?? "unknown",
			"openclaw.channel": evt.channel ?? "unknown",
			"openclaw.session_key": evt.sessionKey ?? "unknown",
			"openclaw.duration_ms": durationMs,
			"openclaw.request_payload_bytes": evt.requestPayloadBytes ?? 0,
			"openclaw.response_stream_bytes": evt.responseStreamBytes ?? 0,
			"openclaw.time_to_first_byte_ms": evt.timeToFirstByteMs ?? 0,
			"openclaw.outcome":
				evt.type === "model.call.error" ? "error" : "completed",
			"openclaw.error_category":
				evt.type === "model.call.error" ? (evt.errorCategory ?? "unknown") : "",
			"openclaw.failure_kind":
				evt.type === "model.call.error" ? (evt.failureKind ?? "unknown") : "",
		},
	});

	if (span) {
		if (evt.type === "model.call.error") {
			span.setStatus({
				code: 2,
				message: evt.failureKind ?? evt.errorCategory ?? "model call error",
			});
		}
		span.end(endTimeMs);
	}
}

function recordModelCallHook(
	evt: ModelCallEndedHookEvent,
	ctx: PluginHookAgentContext,
): void {
	recordModelCallSpan({
		type: evt.outcome === "error" ? "model.call.error" : "model.call.completed",
		ts: Date.now(),
		trace: ctx.trace,
		durationMs: evt.durationMs,
		provider: evt.provider,
		model: evt.model,
		channel: ctx.channel,
		sessionKey: evt.sessionKey ?? ctx.sessionKey,
		requestPayloadBytes: evt.requestPayloadBytes,
		responseStreamBytes: evt.responseStreamBytes,
		timeToFirstByteMs: evt.timeToFirstByteMs,
		errorCategory: evt.errorCategory,
		failureKind: evt.failureKind,
	});
}

// ── Message processed → openclaw.message span ───────────────

function recordMessageProcessed(
	evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
): void {
	withDiagnosticTrace(evt.trace, () => {
		recordMessageProcessedSpan(evt);
	});
}

function recordMessageProcessedSpan(
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

function withDiagnosticTrace(
	trace: DiagnosticTraceContext | undefined,
	fn: () => void,
): void {
	const sentryTrace = formatSentryTraceHeader(trace);
	if (!sentryTrace) {
		fn();
		return;
	}

	Sentry.continueTrace({ sentryTrace, baggage: undefined }, fn);
}

function formatSentryTraceHeader(
	trace: DiagnosticTraceContext | undefined,
): string | undefined {
	if (!trace?.traceId || !trace.spanId) return undefined;

	const sampled = trace.traceFlags === "00" ? "0" : "1";
	return `${trace.traceId}-${trace.spanId}-${sampled}`;
}

// ── Diagnostic log records → Sentry structured logs ──────────

function forwardLogRecord(
	evt: Extract<DiagnosticEventPayload, { type: "log.record" }>,
): void {
	const loggerApi = Sentry.logger;
	if (!loggerApi) return;

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
	getFlushInFlight: () => boolean,
	setFlushInFlight: (value: boolean) => void,
): Promise<void> {
	if (getFlushInFlight()) return;
	setFlushInFlight(true);
	try {
		flushSentryLogs();
		await Sentry.flush(5000);
	} catch {
		// Keep flush failures non-fatal and quiet. Sentry will retry through its SDK.
	} finally {
		setFlushInFlight(false);
	}
}

// ── Plugin entry point ──────────────────────────────────────

export default definePluginEntry({
	id: "sentry",
	name: "Sentry",
	description:
		"Send errors, logs, and traces from your OpenClaw instance to Sentry",
	register(api: OpenClawPluginApi) {
		api.registerService(createSentryService());
		api.logger?.info(
			`sentry: registered service (mode=${api.registrationMode ?? "unknown"})`,
		);
		if (!api.on) {
			api.logger?.warn(
				`sentry: model_call_ended hook registration skipped; plugin API does not expose typed hooks (mode=${api.registrationMode ?? "unknown"})`,
			);
			return;
		}
		api.on(
			"model_call_ended",
			(event, ctx) => {
				try {
					recordModelCallHook(event, ctx);
				} catch {
					// Keep hook failures non-fatal; Sentry telemetry must not affect replies.
				}
			},
			{ timeoutMs: 5000 },
		);
		api.logger?.info("sentry: registered model_call_ended hook");
	},
});
