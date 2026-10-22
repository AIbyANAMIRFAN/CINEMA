import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

config({ path: ".env.local" });
config();

// Uses the direct (unpooled) Neon connection: migrations need session-level features
// that PgBouncer transaction pooling does not provide.
async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL && process.env.SKIP_MIGRATIONS === "1") {
      console.log(JSON.stringify({ level: "warn", msg: "migrate.skipped" }));
      return;
    }
    throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL must be set to run migrations");
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  const started = Date.now();
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.log(JSON.stringify({ level: "info", msg: "migrate.done", ms: Date.now() - started }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "migrate.failed", error: String(err) }));
  process.exit(1);
});
