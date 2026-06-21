import { _INTERNAL_flushLogsBuffer } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
export function createSentryService() {
    let unsubDiag = null;
    let logFlushInterval = null;
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
            unsubDiag = onInternalDiagnosticEvent((evt) => {
                try {
                    if (evt.type === "log.record") {
                        if (enableLogs)
                            forwardLogRecord(evt);
                        return;
                    }
                    handleDiagnosticEvent(evt);
                }
                catch {
                    // Don't let telemetry errors affect the gateway
                }
            });
            ctx.logger.info("sentry: subscribed to diagnostic events");
            if (enableLogs) {
                logFlushInterval = setInterval(flushSentryLogs, 30_000);
                ctx.logger.info("sentry: subscribed to diagnostic log records");
                ctx.logger.info("sentry: flushing diagnostic log records every 30s");
            }
        },
        async stop() {
            unsubDiag?.();
            unsubDiag = null;
            if (logFlushInterval) {
                clearInterval(logFlushInterval);
                logFlushInterval = null;
            }
            flushSentryLogs();
            await Sentry.flush(5000).catch(() => undefined);
        },
    };
}
// ── Diagnostic events → spans / messages ────────────────────
function handleDiagnosticEvent(evt) {
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
function recordMessageProcessed(evt) {
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
// ── Plugin entry point ──────────────────────────────────────
export default function register(api) {
    api.registerService(createSentryService());
}
