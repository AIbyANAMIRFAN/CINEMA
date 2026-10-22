import EmbeddedPostgres from "embedded-postgres";

// Runs a real local PostgreSQL (no Docker needed) for development when Neon isn't connected yet.
// DATABASE_URL=postgres://postgres:postgres@localhost:54322/cinebook
const pg = new EmbeddedPostgres({
  databaseDir: "./.pgdata",
  user: "postgres",
  password: "postgres",
  port: 54322,
  persistent: true,
});

async function main() {
  const fs = await import("node:fs");
  if (!fs.existsSync("./.pgdata/PG_VERSION")) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  const exists = await client.query("select 1 from pg_database where datname = 'cinebook'");
  if (!exists.rowCount) await client.query("create database cinebook");
  await client.end();
  console.log("Local Postgres ready: postgres://postgres:postgres@localhost:54322/cinebook (Ctrl+C to stop)");
  const stop = async () => {
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
