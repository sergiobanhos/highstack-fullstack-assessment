import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, unique, uuid, varchar, char, text } from 'drizzle-orm/pg-core';

export const players = pgTable(
  'players',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    email: varchar('email', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('players_email_unique').on(table.email),
    check('players_email_canonical', sql`${table.email} = lower(btrim(${table.email}))`),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id),
    tokenHash: char('token_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('auth_sessions_token_hash_unique').on(table.tokenHash),
    index('auth_sessions_player_id_idx').on(table.playerId),
    check('auth_sessions_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);
