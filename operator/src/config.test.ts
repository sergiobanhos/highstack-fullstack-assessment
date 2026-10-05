import { describe, expect, test } from 'bun:test';
import {
  createLogger,
  createRedactor,
  loadConfig,
  operatorSecrets,
  type LoggerSink,
} from './config';
import { buildOperatorApp } from './server';

const testEnv = { DATABASE_URL: 'postgres://operator:local-password@127.0.0.1:5432/operator_test' };

const capturingSink = (lines: string[]): LoggerSink => ({
  debug: (line) => lines.push(line),
  info: (line) => lines.push(line),
  warn: (line) => lines.push(line),
  error: (line) => lines.push(line),
});

describe('loadConfig', () => {
  test('applies defaults when the environment is empty', () => {
    const config = loadConfig(testEnv);
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
    expect(config.engine.httpUrl).toBe('http://localhost:4000');
    expect(config.engine.streamUrl).toBe('ws://localhost:4000/stream');
    expect(config.databaseUrl).toBe(testEnv.DATABASE_URL);
    expect(config.authSessionTtlSeconds).toBe(86_400);
  });

  test('strips trailing slashes from the engine HTTP URL', () => {
    const config = loadConfig({ ...testEnv, ENGINE_HTTP_URL: 'http://engine:4000/' });
    expect(config.engine.httpUrl).toBe('http://engine:4000');
  });

  test('rejects invalid configuration without echoing values', () => {
    const secret = 'super-secret-operator-key';
    let message = '';
    try {
      loadConfig({ ...testEnv, PORT: 'not-a-port', ENGINE_OPERATOR_KEY: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('port');
    expect(message).not.toContain(secret);
  });

  test('rejects an unknown log level', () => {
    expect(() => loadConfig({ ...testEnv, LOG_LEVEL: 'verbose' })).toThrow();
  });

  test('requires a valid PostgreSQL URL and never echoes its credentials', () => {
    const secret = 'postgres://auth:private-password@db.invalid/private';
    let message = '';
    try {
      loadConfig({ DATABASE_URL: secret.replace('postgres://', 'mysql://') });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('databaseUrl');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('private-password');
  });

  test('validates the configured auth session lifetime', () => {
    expect(() => loadConfig({ ...testEnv, AUTH_SESSION_TTL_SECONDS: '59' })).toThrow('authSessionTtlSeconds');
    expect(() => loadConfig({ ...testEnv, AUTH_SESSION_TTL_SECONDS: '604801' })).toThrow('authSessionTtlSeconds');
  });
});

describe('createRedactor', () => {
  test('scrubs secrets from text and nested field values', () => {
    const redactor = createRedactor(['dev-operator-key']);
    expect(redactor.text('key=dev-operator-key')).toBe('key=[redacted]');
    const scrubbed = redactor.value({ url: 'ws://engine/stream?key=dev-operator-key' });
    expect(scrubbed.url).toBe('ws://engine/stream?key=[redacted]');
  });

  test('redacts authentication and database fields even when their values are unknown', () => {
    const scrubbed = createRedactor([]).value({
      Authorization: 'Bearer raw-token',
      email: 'player@example.invalid',
      passwordHash: 'argon-hash',
      token: 'raw-token',
      databaseUrl: 'postgres://player:secret@db/operator',
      requestBody: { name: 'Player', password: 'private' },
    });
    expect(scrubbed as unknown).toEqual({
      Authorization: '[redacted]',
      email: '[redacted]',
      passwordHash: '[redacted]',
      token: '[redacted]',
      databaseUrl: '[redacted]',
      requestBody: '[redacted]',
    });
  });
});

describe('logger redaction', () => {
  test('never writes the operator key to the sink', () => {
    const config = loadConfig({ ...testEnv, ENGINE_OPERATOR_KEY: 'top-secret-key' });
    const lines: string[] = [];
    const logger = createLogger({
      level: 'debug',
      redactor: createRedactor(operatorSecrets(config)),
      sink: capturingSink(lines),
    });

    logger.error('connection failed', {
      url: `ws://engine:4000/stream?key=${config.engine.operatorKey}`,
      error: new Error(`bad key ${config.engine.operatorKey}`),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('top-secret-key');
    expect(lines[0]).toContain('[redacted]');
  });

  test('respects the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: capturingSink(lines) });
    logger.info('ignored');
    logger.warn('kept');
    expect(lines).toEqual(['kept']);
  });

  test('includes the database URL in configured secrets', () => {
    const config = loadConfig(testEnv);
    expect(operatorSecrets(config)).toContain(config.databaseUrl);
  });
});

describe('buildOperatorApp', () => {
  test('builds a Fastify app without opening a listening socket', async () => {
    const config = loadConfig(testEnv);
    const { app } = buildOperatorApp(config);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ status: 'ok' }));
    await app.close();
  });
});
