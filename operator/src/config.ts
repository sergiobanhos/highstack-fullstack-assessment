import * as v from 'valibot';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

/**
 * Minimal logging port. Structured fields only; secrets must never be logged
 * (see `createRedactor`, which the logger applies to messages and fields).
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const REDACTED = '[redacted]';

/** Scrubs known secrets out of any text or structured value before it is logged. */
export interface Redactor {
  text(text: string): string;
  value<T>(value: T): T;
}

export function createRedactor(secrets: readonly string[]): Redactor {
  const active = secrets.filter((secret) => secret.length > 0);
  const sensitiveField = /(?:authorization|password|token|secret|email|database.?url|headers|request.?body)/i;
  const isSensitiveField = (key: string): boolean =>
    sensitiveField.test(key) || key.toLowerCase() === 'name' || key.toLowerCase() === 'body';

  const scrubText = (text: string): string => {
    let result = text;
    for (const secret of active) result = result.split(secret).join(REDACTED);
    return result;
  };

  const scrubValue = (value: unknown, depth = 0, key?: string): unknown => {
    if (depth > 8) return REDACTED;
    if (key && isSensitiveField(key)) return REDACTED;
    if (typeof value === 'string') return scrubText(value);
    if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
    if (value instanceof Error) {
      return { name: value.name, message: scrubText(value.message) };
    }
    if (value !== null && typeof value === 'object') {
      const scrubbed: Record<string, unknown> = {};
      for (const [field, item] of Object.entries(value)) scrubbed[field] = scrubValue(item, depth + 1, field);
      return scrubbed;
    }
    return value;
  };

  return {
    text: scrubText,
    value: <T>(value: T): T => scrubValue(value) as T,
  };
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  redactor?: Redactor;
  sink?: LoggerSink;
}

export function createLogger({ level, redactor, sink = console }: CreateLoggerOptions): Logger {
  const threshold = LEVEL_ORDER[level];

  const emit = (
    entryLevel: LogLevel,
    write: (message: string) => void,
    message: string,
    fields?: LogFields,
  ): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) return;

    const text = redactor ? redactor.text(message) : message;
    const safeFields = fields ? (redactor ? redactor.value(fields) : fields) : undefined;
    const line = safeFields ? `${text} ${JSON.stringify(safeFields)}` : text;
    write(line);
  };

  return {
    debug: (message, fields) => emit('debug', (line) => sink.debug(line), message, fields),
    info: (message, fields) => emit('info', (line) => sink.info(line), message, fields),
    warn: (message, fields) => emit('warn', (line) => sink.warn(line), message, fields),
    error: (message, fields) => emit('error', (line) => sink.error(line), message, fields),
  };
}

export interface EngineConfig {
  /** Base HTTP URL of the engine, without a trailing slash. */
  httpUrl: string;
  /** WebSocket stream URL of the engine. */
  streamUrl: string;
  /** Server-only engine operator key. Never sent to clients or written to logs. */
  operatorKey: string;
}

export interface OperatorConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  databaseUrl: string;
  authSessionTtlSeconds: number;
  engine: EngineConfig;
}

export type EnvSource = Record<string, string | undefined>;

const isUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

const isPostgresUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.hostname.length > 0 &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
};

const configSchema = v.object({
  port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
  host: v.pipe(v.string(), v.minLength(1)),
  logLevel: v.picklist(LOG_LEVELS),
  databaseUrl: v.pipe(v.string(), v.trim(), v.check(isPostgresUrl, 'must be a valid PostgreSQL URL')),
  authSessionTtlSeconds: v.pipe(v.number(), v.integer(), v.minValue(60), v.maxValue(604_800)),
  engine: v.object({
    httpUrl: v.pipe(v.string(), v.check(isUrl, 'must be a valid URL')),
    streamUrl: v.pipe(v.string(), v.check(isUrl, 'must be a valid URL')),
    operatorKey: v.pipe(v.string(), v.minLength(1)),
  }),
});

const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const toPort = (value: string | undefined): number => Number(value ?? 3000);

/**
 * Reads and validates operator configuration. Throws on invalid input with a
 * field-path-only message so configuration values (which may include the engine
 * operator key) are never echoed back.
 */
export function loadConfig(env: EnvSource): OperatorConfig {
  const candidate = {
    port: toPort(env.PORT),
    host: env.HOST ?? '0.0.0.0',
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: env.DATABASE_URL,
    authSessionTtlSeconds: Number(env.AUTH_SESSION_TTL_SECONDS ?? 86_400),
    engine: {
      httpUrl: stripTrailingSlash(env.ENGINE_HTTP_URL ?? 'http://localhost:4000'),
      streamUrl: env.ENGINE_STREAM_URL ?? 'ws://localhost:4000/stream',
      operatorKey: env.ENGINE_OPERATOR_KEY ?? 'dev-operator-key',
    },
  };

  const result = v.safeParse(configSchema, candidate);
  if (!result.success) {
    const paths = result.issues
      .map((issue) => issue.path?.map((segment) => String(segment.key)).join('.') ?? '(root)')
      .join(', ');
    throw new Error(`Invalid operator configuration at: ${paths}`);
  }

  return result.output;
}

/** Secret values that must be scrubbed from logs for a given configuration. */
export function operatorSecrets(config: OperatorConfig): string[] {
  return [config.engine.operatorKey, config.databaseUrl];
}
