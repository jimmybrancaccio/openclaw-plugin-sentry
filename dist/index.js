import * as Sentry from "@sentry/node";
import { onDiagnosticEvent, registerLogTransport } from "openclaw/plugin-sdk";
export function createSentryService() {
    let unsubDiag = null;
    let unsubLogs = null;
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
            unsubDiag = onDiagnosticEvent((evt) => {
                try {
                    handleDiagnosticEvent(evt);
                }
                catch {
                    // Don't let telemetry errors affect the gateway
                }
            });
            ctx.logger.info("sentry: subscribed to diagnostic events");
            // ── 3. Gateway logs → Sentry structured logs ───────────
            if (enableLogs) {
                unsubLogs = registerLogTransport((logObj) => {
                    try {
                        forwardLog(logObj);
                    }
                    catch {
                        // Silent — don't let log forwarding errors cascade
                    }
                });
                ctx.logger.info("sentry: subscribed to log transport");
            }
        },
        async stop() {
            unsubDiag?.();
            unsubDiag = null;
            unsubLogs?.();
            unsubLogs = null;
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
// ── Log forwarding → Sentry structured logs ─────────────────
function forwardLog(logObj) {
    const meta = logObj._meta;
    const level = (meta?.logLevelName ?? "INFO").toLowerCase();
    // OpenClaw log transport format: numeric keys are positional args.
    // Typically: "0" = subsystem/context tag, "1" = message string
    const numericEntries = Object.entries(logObj)
        .filter(([key]) => /^\d+$/.test(key))
        .sort((a, b) => Number(a[0]) - Number(b[0]));
    let subsystem = "";
    let message = "";
    if (numericEntries.length >= 2) {
        // First arg is usually the subsystem tag, last is the message
        subsystem = String(numericEntries[0][1]);
        const lastVal = numericEntries[numericEntries.length - 1][1];
        message = typeof lastVal === "string" ? lastVal : JSON.stringify(lastVal);
    }
    else if (numericEntries.length === 1) {
        const val = numericEntries[0][1];
        message = typeof val === "string" ? val : JSON.stringify(val);
    }
    if (!message)
        message = "log";
    const loggerName = meta?.name ?? "openclaw";
    const loggerApi = Sentry.logger;
    if (!loggerApi)
        return;
    const attrs = {
        "openclaw.logger": loggerName,
    };
    if (subsystem) {
        attrs["openclaw.subsystem"] = subsystem;
    }
    // Route to appropriate Sentry log level
    switch (level) {
        case "debug":
        case "trace":
            loggerApi.debug(message, attrs);
            break;
        case "warn":
            loggerApi.warn(message, attrs);
            break;
        case "error":
        case "fatal":
            loggerApi.error(message, attrs);
            break;
        default:
            loggerApi.info(message, attrs);
    }
}
// ── Plugin entry point ──────────────────────────────────────
export default function register(api) {
    api.registerService(createSentryService());
}
