import { defineConfig } from 'drizzle-kit';

// Schema is the source of truth for types; SQL migrations are hand-written in
// ./migrations (FTS5 virtual tables cannot be expressed in Drizzle schema).
// Use `pnpm exec drizzle-kit generate` to diff schema.ts against migrations
// when adding new ordinary tables/columns.
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
});
