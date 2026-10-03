import { describe, expect, test } from 'bun:test';
import {
  createLogger,
  createRedactor,
  loadConfig,
  operatorSecrets,
  type LoggerSink,
} from './config';
import { buildOperatorApp } from './server';

const capturingSink = (lines: string[]): LoggerSink => ({
  debug: (line) => lines.push(line),
  info: (line) => lines.push(line),
  warn: (line) => lines.push(line),
  error: (line) => lines.push(line),
});

describe('loadConfig', () => {
  test('applies defaults when the environment is empty', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('info');
    expect(config.engine.httpUrl).toBe('http://localhost:4000');
    expect(config.engine.streamUrl).toBe('ws://localhost:4000/stream');
  });

  test('strips trailing slashes from the engine HTTP URL', () => {
    const config = loadConfig({ ENGINE_HTTP_URL: 'http://engine:4000/' });
    expect(config.engine.httpUrl).toBe('http://engine:4000');
  });

  test('rejects invalid configuration without echoing values', () => {
    const secret = 'super-secret-operator-key';
    let message = '';
    try {
      loadConfig({ PORT: 'not-a-port', ENGINE_OPERATOR_KEY: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('port');
    expect(message).not.toContain(secret);
  });

  test('rejects an unknown log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow();
  });
});

describe('createRedactor', () => {
  test('scrubs secrets from text and nested field values', () => {
    const redactor = createRedactor(['dev-operator-key']);
    expect(redactor.text('key=dev-operator-key')).toBe('key=[redacted]');
    const scrubbed = redactor.value({ url: 'ws://engine/stream?key=dev-operator-key' });
    expect(scrubbed.url).toBe('ws://engine/stream?key=[redacted]');
  });
});

describe('logger redaction', () => {
  test('never writes the operator key to the sink', () => {
    const config = loadConfig({ ENGINE_OPERATOR_KEY: 'top-secret-key' });
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
});

describe('buildOperatorApp', () => {
  test('builds a Fastify app without opening a listening socket', async () => {
    const config = loadConfig({});
    const { app } = buildOperatorApp(config);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ status: 'ok' }));
    await app.close();
  });
});