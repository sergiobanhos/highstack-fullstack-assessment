import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as authSchema from './modules/auth/auth.schema';

export type OperatorDatabase = PostgresJsDatabase<typeof authSchema>;

export interface DatabaseConnection {
  db: OperatorDatabase;
  check(): Promise<void>;
  checkSchema(): Promise<void>;
  close(): Promise<void>;
}

function validateDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    const isPostgres = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
    if (!isPostgres || !url.hostname || url.pathname.length < 2) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }

  return value;
}

/** Creates the shared PostgreSQL pool and Drizzle database without connecting eagerly. */
export function createDatabase(databaseUrl: string): DatabaseConnection {
  const connectionString = validateDatabaseUrl(databaseUrl);
  const client = postgres(connectionString, {
    max: 5,
    connect_timeout: 5,
    connection: { statement_timeout: 5_000 },
    onnotice: () => undefined,
  });
  const db = drizzle({ client, schema: authSchema });
  let closed = false;

  return {
    db,
    async check() {
      if (closed) throw new Error('Database connection is closed');
      try {
        await client`select 1`;
      } catch {
        throw new Error('Database is unavailable');
      }
    },
    async checkSchema() {
      if (closed) throw new Error('Database connection is closed');
      try {
        await client`select 1 from players limit 0`;
        await client`select 1 from auth_sessions limit 0`;
      } catch {
        throw new Error('Database schema is not ready');
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.end({ timeout: 5 });
    },
  };
}
