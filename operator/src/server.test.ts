import { describe, expect, test } from 'bun:test';
import type { OperatorDatabase, DatabaseConnection } from './db';
import { loadConfig } from './config';
import { buildOperatorApp, checkOperatorReadiness } from './server';

function makeDatabase(overrides: Partial<Pick<DatabaseConnection, 'check' | 'checkSchema' | 'close'>> = {}): DatabaseConnection {
  return {
    db: {} as OperatorDatabase,
    check: overrides.check ?? (async () => undefined),
    checkSchema: overrides.checkSchema ?? (async () => undefined),
    close: overrides.close ?? (async () => undefined),
  };
}

function testConfig() {
  return loadConfig({
    DATABASE_URL: 'postgres://operator:private-test-password@127.0.0.1:5432/operator_test',
  });
}

describe('operator composition and readiness', () => {
  test('keeps liveness separate from database readiness and registers auth routes', async () => {
    let connectionChecks = 0;
    let schemaChecks = 0;
    const database = makeDatabase({
      check: async () => { connectionChecks += 1; },
      checkSchema: async () => { schemaChecks += 1; },
    });
    const operator = buildOperatorApp(testConfig(), { databaseConnection: database });

    try {
      await operator.app.ready();
      const health = await operator.app.inject({ method: 'GET', url: '/health' });
      const ready = await operator.app.inject({ method: 'GET', url: '/ready' });

      expect(health.statusCode).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: 'ok' });
      expect(ready.statusCode).toBe(200);
      expect(JSON.parse(ready.body)).toEqual({ status: 'ready' });
      expect(connectionChecks).toBe(1);
      expect(schemaChecks).toBe(1);
      expect(operator.app.hasRoute({ method: 'POST', url: '/auth/login' })).toBe(true);
      expect(operator.app.hasRoute({ method: 'GET', url: '/game/events' })).toBe(true);
    } finally {
      await operator.app.close();
    }
  });

  test('returns a generic 503 when schema is unavailable while liveness stays healthy', async () => {
    const database = makeDatabase({ checkSchema: async () => { throw new Error('private database details'); } });
    const operator = buildOperatorApp(testConfig(), { databaseConnection: database });

    try {
      const ready = await operator.app.inject({ method: 'GET', url: '/ready' });
      const health = await operator.app.inject({ method: 'GET', url: '/health' });

      expect(ready.statusCode).toBe(503);
      expect(JSON.parse(ready.body)).toEqual({ status: 'not_ready' });
      expect(ready.body).not.toContain('private database details');
      expect(health.statusCode).toBe(200);
    } finally {
      await operator.app.close();
    }
  });

  test('fails the pre-listen dependency check without querying schema after connection loss', async () => {
    let schemaChecks = 0;
    const database = makeDatabase({
      check: async () => { throw new Error('Database is unavailable'); },
      checkSchema: async () => { schemaChecks += 1; },
    });

    await expect(checkOperatorReadiness({ database })).rejects.toThrow(
      'Database is unavailable',
    );
    expect(schemaChecks).toBe(0);
  });

  test('closes the database pool with the HTTP application', async () => {
    let closeCalls = 0;
    const database = makeDatabase({ close: async () => { closeCalls += 1; } });
    const operator = buildOperatorApp(testConfig(), { databaseConnection: database });

    await operator.app.close();
    expect(closeCalls).toBe(1);
  });
});
