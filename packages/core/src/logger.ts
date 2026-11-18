const SENSITIVE_KEY_PATTERN =
  /(password|secret|token|apikey|api_key|authorization|cookie|credential|access_key|private_key)/i;

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

type LogLevel = keyof typeof LEVELS;

function getMinLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[configured] ?? LEVELS.info;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Truncated]";
  if (value === null || value === undefined) return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: process.env.NODE_ENV === "development" ? value.stack : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }

  if (typeof value === "string") {
    if (/^(Bearer\s+|sk-[a-zA-Z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,})/.test(value)) {
      return "[REDACTED]";
    }
  }

  return value;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function createLogger(
  service: string,
  baseContext: Record<string, unknown> = {},
): Logger {
  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < getMinLevel()) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...(redactValue(baseContext) as Record<string, unknown>),
      ...(meta ? (redactValue(meta) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (ctx) => createLogger(service, { ...baseContext, ...ctx }),
  };
}
