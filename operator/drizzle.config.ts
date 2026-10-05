import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/modules/auth/auth.schema.ts', './src/modules/financial/financial.schema.ts'],
  out: './drizzle',
});
