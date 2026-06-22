import { _INTERNAL_flushLogsBuffer } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
const activeModelCalls = new Map();
const pendingTraceEnvelopes = new Set();
let sentryEnvelopeConfig = null;
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
            const environment = pluginCfg?.environment ?? "production";
            if (!dsn) {
                ctx.logger.warn("sentry: no DSN configured — skipping init");
                return;
            }
            const envelopeConfig = resolveSentryEnvelopeConfig(dsn, environment);
            if (!envelopeConfig) {
                ctx.logger.warn("sentry: invalid DSN configured — skipping init");
                return;
            }
            sentryEnvelopeConfig = envelopeConfig;
            // ── 1. Init Sentry SDK ──────────────────────────────────
            const enableLogs = pluginCfg?.enableLogs !== false; // default true
            Sentry.init({
                dsn,
                environment,
                tracesSampleRate: pluginCfg?.tracesSampleRate ?? 1.0,
                enableLogs, // top-level in Sentry SDK v10+
            });
            ctx.logger.info(`sentry: initialized (dsn=...${dsn.slice(-12)}, env=${environment}, logs=${enableLogs})`);
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
            endActiveModelCalls();
            if (telemetryFlushInterval) {
                clearInterval(telemetryFlushInterval);
                telemetryFlushInterval = null;
            }
            flushSentryLogs();
            await flushTraceEnvelopes(5000);
            await Sentry.flush(5000).catch(() => undefined);
            sentryEnvelopeConfig = null;
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
    const spanName = evt.model ? `chat ${evt.model}` : "chat unknown";
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs ?? 100;
    const startTimeMs = endTimeMs - durationMs;
    captureTransactionEnvelope({
        name: spanName,
        op: "ai.chat",
        trace: evt.trace,
        startTimeMs,
        endTimeMs,
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
}
// ── Model call lifecycle → ai.chat transaction ──────────────
function recordModelCallStarted(evt) {
    const key = modelCallSpanKey(evt);
    if (!key)
        return;
    activeModelCalls.set(key, {
        name: modelCallSpanName(evt),
        op: "ai.chat",
        startTimeMs: evt.ts,
        trace: evt.trace,
        attributes: modelCallAttributes(evt, { outcome: "started" }),
    });
}
function recordModelCall(evt) {
    const key = modelCallSpanKey(evt);
    const activeCall = key ? activeModelCalls.get(key) : undefined;
    if (key && activeCall) {
        activeModelCalls.delete(key);
        finishModelCallTransaction(activeCall, evt);
        return;
    }
    recordModelCallTransaction(evt);
}
function finishModelCallTransaction(activeCall, evt) {
    const durationMs = evt.durationMs ?? 100;
    captureTransactionEnvelope({
        name: activeCall.name,
        op: activeCall.op,
        trace: evt.trace ?? activeCall.trace,
        startTimeMs: activeCall.startTimeMs,
        endTimeMs: evt.ts,
        status: evt.type === "model.call.error" ? "internal_error" : "ok",
        statusMessage: evt.type === "model.call.error"
            ? (evt.failureKind ?? evt.errorCategory ?? "model call error")
            : undefined,
        attributes: {
            ...activeCall.attributes,
            ...modelCallAttributes(evt, {
                durationMs,
                outcome: evt.type === "model.call.error" ? "error" : "completed",
            }),
        },
    });
}
function recordModelCallTransaction(evt) {
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs ?? 100;
    const startTimeMs = endTimeMs - durationMs;
    captureTransactionEnvelope({
        name: modelCallSpanName(evt),
        op: "ai.chat",
        trace: evt.trace,
        startTimeMs,
        endTimeMs,
        status: evt.type === "model.call.error" ? "internal_error" : "ok",
        statusMessage: evt.type === "model.call.error"
            ? (evt.failureKind ?? evt.errorCategory ?? "model call error")
            : undefined,
        attributes: modelCallAttributes(evt, {
            durationMs,
            outcome: evt.type === "model.call.error" ? "error" : "completed",
        }),
    });
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
function endActiveModelCalls() {
    const endTimeMs = Date.now();
    for (const activeCall of activeModelCalls.values()) {
        captureTransactionEnvelope({
            name: activeCall.name,
            op: activeCall.op,
            trace: activeCall.trace,
            startTimeMs: activeCall.startTimeMs,
            endTimeMs,
            status: "deadline_exceeded",
            statusMessage: "model call span ended during plugin stop",
            attributes: {
                ...activeCall.attributes,
                "openclaw.outcome": "interrupted",
            },
        });
    }
    activeModelCalls.clear();
}
// ── Message processed → openclaw.message span ───────────────
function recordMessageDispatchCompleted(evt) {
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs;
    const startTimeMs = endTimeMs - durationMs;
    captureTransactionEnvelope({
        name: `message.dispatch.${evt.outcome}`,
        op: "openclaw.message.dispatch",
        trace: evt.trace,
        startTimeMs,
        endTimeMs,
        status: evt.outcome === "error" ? "internal_error" : "ok",
        statusMessage: evt.outcome === "error" ? evt.error : undefined,
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
    if (evt.outcome === "error" && evt.error) {
        Sentry.captureMessage(`Message dispatch error: ${evt.error}`, {
            level: "error",
            tags: {
                channel: evt.channel ?? "unknown",
                sessionKey: evt.sessionKey,
            },
        });
    }
}
function recordMessageProcessed(evt) {
    const endTimeMs = evt.ts;
    const durationMs = evt.durationMs ?? 50;
    const startTimeMs = endTimeMs - durationMs;
    captureTransactionEnvelope({
        name: `message.${evt.outcome}`,
        op: "openclaw.message",
        trace: evt.trace,
        startTimeMs,
        endTimeMs,
        status: evt.outcome === "error" ? "internal_error" : "ok",
        statusMessage: evt.outcome === "error" ? evt.error : undefined,
        attributes: {
            "openclaw.channel": evt.channel,
            "openclaw.outcome": evt.outcome,
            "openclaw.session_key": evt.sessionKey ?? "unknown",
            "openclaw.chat_id": String(evt.chatId ?? ""),
            "openclaw.message_id": String(evt.messageId ?? ""),
            "openclaw.duration_ms": durationMs,
        },
    });
    if (evt.outcome === "error" && evt.error) {
        Sentry.captureMessage(`Message processing error: ${evt.error}`, {
            level: "error",
            tags: { channel: evt.channel, sessionKey: evt.sessionKey },
        });
    }
}
// ── Sentry transaction envelopes ────────────────────────────
function resolveSentryEnvelopeConfig(dsn, environment) {
    try {
        const url = new URL(dsn);
        const projectId = url.pathname.split("/").filter(Boolean).at(-1);
        if (!projectId)
            return null;
        return {
            dsn,
            endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`,
            environment,
        };
    }
    catch {
        return null;
    }
}
function captureTransactionEnvelope(options) {
    const config = sentryEnvelopeConfig;
    if (!config)
        return;
    const eventId = randomHex(16);
    const traceId = validTraceId(options.trace?.traceId)
        ? options.trace.traceId
        : randomHex(16);
    const spanId = validSpanId(options.trace?.spanId)
        ? options.trace.spanId
        : randomHex(8);
    const parentSpanId = validSpanId(options.trace?.parentSpanId)
        ? options.trace.parentSpanId
        : undefined;
    const startTimestamp = toSentryTimestamp(options.startTimeMs);
    const endTimestamp = Math.max(startTimestamp, toSentryTimestamp(options.endTimeMs));
    const attributes = options.attributes ?? {};
    const event = {
        event_id: eventId,
        type: "transaction",
        transaction: options.name,
        platform: "node",
        environment: config.environment,
        start_timestamp: startTimestamp,
        timestamp: endTimestamp,
        contexts: {
            trace: {
                trace_id: traceId,
                span_id: spanId,
                ...(parentSpanId ? { parent_span_id: parentSpanId } : {}),
                op: options.op,
                status: options.status ?? "ok",
                ...(Object.keys(attributes).length > 0 ? { data: attributes } : {}),
            },
            openclaw: attributes,
        },
        transaction_info: { source: "custom" },
        tags: transactionTags(attributes),
        spans: [],
        ...(options.statusMessage ? { message: options.statusMessage } : {}),
    };
    const envelope = `${JSON.stringify({
        dsn: config.dsn,
        sent_at: new Date().toISOString(),
    })}\n${JSON.stringify({ type: "transaction" })}\n${JSON.stringify(event)}\n`;
    const pending = fetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope,
    })
        .then(async (res) => {
        if (!res.ok) {
            throw new Error(`Sentry transaction envelope rejected (${res.status})`);
        }
    })
        .catch(() => undefined)
        .finally(() => {
        pendingTraceEnvelopes.delete(pending);
    });
    pendingTraceEnvelopes.add(pending);
}
function transactionTags(attributes) {
    const tags = {};
    for (const key of [
        "openclaw.channel",
        "openclaw.outcome",
        "openclaw.provider",
        "openclaw.model",
        "gen_ai.operation.name",
    ]) {
        const value = attributes[key];
        if (value !== undefined)
            tags[key] = String(value).slice(0, 200);
    }
    return tags;
}
function toSentryTimestamp(timeMs) {
    return timeMs > 9_999_999_999 ? timeMs / 1000 : timeMs;
}
function validTraceId(value) {
    return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value);
}
function validSpanId(value) {
    return typeof value === "string" && /^[a-f0-9]{16}$/i.test(value);
}
function randomHex(bytes) {
    let value = "";
    for (let i = 0; i < bytes; i += 1) {
        value += Math.floor(Math.random() * 256)
            .toString(16)
            .padStart(2, "0");
    }
    return value;
}
async function flushTraceEnvelopes(timeoutMs) {
    if (pendingTraceEnvelopes.size === 0)
        return;
    await Promise.race([
        Promise.allSettled([...pendingTraceEnvelopes]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
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
        await flushTraceEnvelopes(5000);
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
