import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  // Only used by `drizzle-kit` commands that talk to a DB; migrations are applied by scripts/migrate.ts.
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost/unused" },
});
