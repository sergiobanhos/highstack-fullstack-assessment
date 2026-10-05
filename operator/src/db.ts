import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as authSchema from './modules/auth/auth.schema';
import * as financialSchema from './modules/financial/financial.schema';
import * as gameSchema from './modules/game/game.schema';

const databaseSchema = { ...authSchema, ...financialSchema, ...gameSchema };

export type OperatorDatabase = PostgresJsDatabase<typeof databaseSchema>;

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
  const db = drizzle({ client, schema: databaseSchema });
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
        await client`select 1 from wallets limit 0`;
        await client`select 1 from financial_operations limit 0`;
        await client`select 1 from wallet_ledger_entries limit 0`;
        await client`select 1 from payouts limit 0`;
        await client`select 1 from game_commands limit 0`;
        await client`select 1 from game_bets limit 0`;
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
