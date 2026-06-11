/**
 * Programmatic migration runner: applies SQL migrations from src/db/migrations
 * to the database at DATABASE_URL. Exits non-zero on failure.
 *
 * Used by `npm run db:migrate` and the docker-compose `migrate` service.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "src/db/migrations" });
    console.log("[migrate] all migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
