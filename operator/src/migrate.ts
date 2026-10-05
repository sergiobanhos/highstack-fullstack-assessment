import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './db';

async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations');

  const connection = createDatabase(databaseUrl);
  try {
    await connection.check();
    await migrate(connection.db, {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } finally {
    await connection.close();
  }
}

if (import.meta.main) {
  runMigrations().catch(() => {
    console.error('Database migration failed. Check database availability and migration configuration.');
    process.exitCode = 1;
  });
}
