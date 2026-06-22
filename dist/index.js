import { _INTERNAL_flushLogsBuffer } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
const activeModelCallSpans = new Map();
export function createSentryService() {
    let unsubDiag = null;
    let telemetryFlushInterval = null;
    let flushInFlight = false;
    return {
        id: "sentry",
        async start(ctx) {
            ctx.logger.info("sentry: start() entered");
            const entries = ctx.config.plugins?.entries;
            const pluginCfg = entries?.sentry?.config;
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
            ctx.logger.info(`sentry: initialized (dsn=...${dsn.slice(-12)}, env=${pluginCfg?.environment ?? "production"}, logs=${enableLogs})`);
            // ── 2. Diagnostic events → Sentry spans + messages ─────
            const handleEvent = (evt, metadata = {}) => {
                try {
                    if (evt.type === "log.record") {
                        if (enableLogs)
                            forwardLogRecord(evt);
                        return;
                    }
                    handleDiagnosticEvent(evt, metadata);
                }
                catch {
                    // Don't let telemetry errors affect the gateway
                }
            };
            if (ctx.internalDiagnostics?.onEvent) {
                unsubDiag = ctx.internalDiagnostics.onEvent((evt, metadata) => {
                    handleEvent(evt, metadata);
                });
                ctx.logger.info("sentry: subscribed to internal diagnostic events");
            }
            else {
                unsubDiag = onInternalDiagnosticEvent((evt) => {
                    handleEvent(evt);
                });
                ctx.logger.info("sentry: subscribed to diagnostic events");
            }
            if (enableLogs) {
                ctx.logger.info("sentry: subscribed to diagnostic log records");
            }
            telemetryFlushInterval = setInterval(() => {
                void flushSentryTelemetry(() => flushInFlight, (value) => {
                    flushInFlight = value;
                });
            }, 30_000);
            ctx.logger.info("sentry: flushing telemetry every 30s");
        },
        async stop() {
            unsubDiag?.();
            unsubDiag = null;
            endActiveModelCallSpans();
            if (telemetryFlushInterval) {
                clearInterval(telemetryFlushInterval);
                telemetryFlushInterval = null;
            }
            flushSentryLogs();
            await Sentry.flush(5000).catch(() => undefined);
        },
    };
}
// ── Diagnostic events → spans / messages ────────────────────
function handleDiagnosticEvent(evt, _metadata = {}) {
    switch (evt.type) {
        case "model.call.started":
            recordModelCallStarted(evt);
            return;
        case "model.usage":
            recordModelUsage(evt);
            return;
        case "message.processed":
            recordMessageProcessed(evt);
            return;
        case "message.dispatch.completed":
            recordMessageDispatchCompleted(evt);
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
            Sentry.captureMessage(`Session stuck: ${evt.sessionKey} (${evt.ageMs}ms)`, {
                level: "warning",
                tags: { sessionKey: evt.sessionKey, state: evt.state },
            });
            return;
        case "log.record":
            return;
        // Silently ignore event types we don't handle (webhook.received,
        // session.state, queue.lane.*, diagnostic.heartbeat, etc.)
    }
}
// ── Model usage → ai.chat span with real duration ───────────
function recordModelUsage(evt) {
    withDiagnosticTrace(evt.trace, () => {
        recordModelUsageSpan(evt);
    });
}
function recordModelUsageSpan(evt) {
    const spanName = evt.model ? `chat ${evt.model}` : "chat unknown";
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs ?? 100;
    const startTimeMs = endTimeMs - durationMs;
    const span = startTelemetrySegment({
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
function recordModelCallStarted(evt) {
    const key = modelCallSpanKey(evt);
    if (!key)
        return;
    withDiagnosticTrace(parentTraceContext(evt.trace), () => {
        const span = startTelemetrySegment({
            op: "ai.chat",
            name: modelCallSpanName(evt),
            startTime: evt.ts,
            forceTransaction: true,
            attributes: modelCallAttributes(evt, { outcome: "started" }),
        });
        activeModelCallSpans.set(key, span);
    });
}
function recordModelCall(evt) {
    const key = modelCallSpanKey(evt);
    const activeSpan = key ? activeModelCallSpans.get(key) : undefined;
    if (key && activeSpan) {
        activeModelCallSpans.delete(key);
        finishModelCallSpan(activeSpan, evt);
        return;
    }
    withDiagnosticTrace(evt.trace, () => {
        recordModelCallSpan(evt);
    });
}
function finishModelCallSpan(span, evt) {
    const durationMs = evt.durationMs ?? 100;
    span.setAttributes?.(modelCallAttributes(evt, {
        durationMs,
        outcome: evt.type === "model.call.error" ? "error" : "completed",
    }));
    if (evt.type === "model.call.error") {
        span.setStatus({
            code: 2,
            message: evt.failureKind ?? evt.errorCategory ?? "model call error",
        });
    }
    span.end(evt.ts);
}
function recordModelCallSpan(evt) {
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs ?? 100;
    const startTimeMs = endTimeMs - durationMs;
    const span = startTelemetrySegment({
        op: "ai.chat",
        name: modelCallSpanName(evt),
        startTime: startTimeMs,
        forceTransaction: true,
        attributes: modelCallAttributes(evt, {
            durationMs,
            outcome: evt.type === "model.call.error" ? "error" : "completed",
        }),
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
function modelCallSpanName(evt) {
    return evt.model ? `model call ${evt.model}` : "model call unknown";
}
function modelCallAttributes(evt, options) {
    const attrs = {
        "gen_ai.operation.name": genAiOperationName(evt.api),
        "gen_ai.system": evt.provider ?? "unknown",
        "gen_ai.request.model": evt.model ?? "unknown",
        "openclaw.provider": evt.provider ?? "unknown",
        "openclaw.model": evt.model ?? "unknown",
        "openclaw.outcome": options.outcome,
    };
    if (evt.runId)
        attrs["openclaw.run_id"] = evt.runId;
    if (evt.callId)
        attrs["openclaw.call_id"] = evt.callId;
    if ("sessionId" in evt)
        attrs["openclaw.session_id"] = evt.sessionId ?? "";
    if ("channel" in evt)
        attrs["openclaw.channel"] = evt.channel ?? "unknown";
    if ("sessionKey" in evt) {
        attrs["openclaw.session_key"] = evt.sessionKey ?? "unknown";
    }
    if (evt.api)
        attrs["openclaw.api"] = evt.api;
    if (evt.transport)
        attrs["openclaw.transport"] = evt.transport;
    if (options.durationMs !== undefined) {
        attrs["openclaw.duration_ms"] = options.durationMs;
    }
    if ("requestPayloadBytes" in evt && evt.requestPayloadBytes !== undefined) {
        attrs["openclaw.request_payload_bytes"] = evt.requestPayloadBytes;
    }
    if ("responseStreamBytes" in evt && evt.responseStreamBytes !== undefined) {
        attrs["openclaw.response_stream_bytes"] = evt.responseStreamBytes;
    }
    if ("timeToFirstByteMs" in evt && evt.timeToFirstByteMs !== undefined) {
        attrs["openclaw.time_to_first_byte_ms"] = evt.timeToFirstByteMs;
    }
    if ("upstreamRequestIdHash" in evt && evt.upstreamRequestIdHash) {
        attrs["openclaw.upstream_request_id_hash"] = evt.upstreamRequestIdHash;
    }
    if (evt.type === "model.call.error") {
        attrs["openclaw.error_category"] = evt.errorCategory ?? "unknown";
        attrs["openclaw.failure_kind"] = evt.failureKind ?? "unknown";
        attrs["error.type"] = evt.errorCategory ?? "unknown";
    }
    return attrs;
}
function genAiOperationName(api) {
    const normalized = api?.trim().toLowerCase();
    if (!normalized)
        return "chat";
    if (normalized === "completions" || normalized.endsWith("-completions")) {
        return "text_completion";
    }
    if (normalized === "generate_content" ||
        normalized.includes("generative-ai")) {
        return "generate_content";
    }
    return "chat";
}
function modelCallSpanKey(evt) {
    if (evt.runId && evt.callId)
        return `${evt.runId}:${evt.callId}`;
    return evt.trace?.spanId;
}
function parentTraceContext(trace) {
    if (!trace?.traceId || !trace.parentSpanId)
        return undefined;
    return {
        traceId: trace.traceId,
        spanId: trace.parentSpanId,
        traceFlags: trace.traceFlags,
    };
}
function endActiveModelCallSpans() {
    const endTimeMs = Date.now();
    for (const span of activeModelCallSpans.values()) {
        span.end(endTimeMs);
    }
    activeModelCallSpans.clear();
}
// ── Message processed → openclaw.message span ───────────────
function recordMessageDispatchCompleted(evt) {
    withDiagnosticTrace(evt.trace, () => {
        recordMessageDispatchCompletedSpan(evt);
    });
}
function recordMessageDispatchCompletedSpan(evt) {
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs;
    const startTimeMs = endTimeMs - durationMs;
    const span = startTelemetrySegment({
        op: "openclaw.message.dispatch",
        name: `message.dispatch.${evt.outcome}`,
        startTime: startTimeMs,
        forceTransaction: true,
        attributes: {
            "openclaw.channel": evt.channel ?? "unknown",
            "openclaw.outcome": evt.outcome,
            "openclaw.reason": evt.reason ?? "",
            "openclaw.source": evt.source,
            "openclaw.session_key": evt.sessionKey ?? "unknown",
            "openclaw.session_id": evt.sessionId ?? "",
            "openclaw.duration_ms": durationMs,
        },
    });
    if (span) {
        if (evt.outcome === "error") {
            span.setStatus({
                code: 2,
                message: evt.error ?? "message dispatch error",
            });
            if (evt.error) {
                Sentry.captureMessage(`Message dispatch error: ${evt.error}`, {
                    level: "error",
                    tags: {
                        channel: evt.channel ?? "unknown",
                        sessionKey: evt.sessionKey,
                    },
                });
            }
        }
        span.end(endTimeMs);
    }
}
function recordMessageProcessed(evt) {
    withDiagnosticTrace(evt.trace, () => {
        recordMessageProcessedSpan(evt);
    });
}
function recordMessageProcessedSpan(evt) {
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs ?? 50;
    const startTimeMs = endTimeMs - durationMs;
    const span = startTelemetrySegment({
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
function startTelemetrySegment(options) {
    return Sentry.startSpanManual({
        parentSpan: null,
        forceTransaction: true,
        ...options,
        experimental: {
            ...options.experimental,
            standalone: true,
        },
    }, (span) => span);
}
function withDiagnosticTrace(trace, fn) {
    const sentryTrace = formatSentryTraceHeader(trace);
    if (!sentryTrace) {
        fn();
        return;
    }
    Sentry.continueTrace({ sentryTrace, baggage: undefined }, fn);
}
function formatSentryTraceHeader(trace) {
    if (!trace?.traceId || !trace.spanId)
        return undefined;
    const sampled = trace.traceFlags === "00" ? "0" : "1";
    return `${trace.traceId}-${trace.spanId}-${sampled}`;
}
// ── Diagnostic log records → Sentry structured logs ──────────
function forwardLogRecord(evt) {
    const loggerApi = Sentry.logger;
    if (!loggerApi)
        return;
    const attrs = {
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
function flushSentryLogs() {
    const client = Sentry.getClient();
    if (client) {
        _INTERNAL_flushLogsBuffer(client);
    }
}
async function flushSentryTelemetry(getFlushInFlight, setFlushInFlight) {
    if (getFlushInFlight())
        return;
    setFlushInFlight(true);
    try {
        flushSentryLogs();
        await Sentry.flush(5000);
    }
    catch {
        // Keep flush failures non-fatal and quiet. Sentry will retry through its SDK.
    }
    finally {
        setFlushInFlight(false);
    }
}
// ── Plugin entry point ──────────────────────────────────────
export default definePluginEntry({
    id: "sentry",
    name: "Sentry",
    description: "Send errors, logs, and traces from your OpenClaw instance to Sentry",
    register(api) {
        api.registerService(createSentryService());
        api.logger?.info(`sentry: registered service (mode=${api.registrationMode ?? "unknown"})`);
    },
});
