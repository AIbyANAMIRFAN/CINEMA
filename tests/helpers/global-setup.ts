import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

// One real PostgreSQL 18 instance for the whole test run (port 54330). Each test file creates its
// own database. A per-run data dir avoids clashing with a cluster left behind by a killed run.
const PORT = Number(process.env.TEST_PG_PORT ?? 54330);
const ROOT = path.resolve(".");
const DATA_DIR = path.join(ROOT, `.pgdata-test-${process.pid}`);

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let pg: EmbeddedPostgres | undefined;

function removeStaleDirs() {
  for (const name of fs.readdirSync(ROOT)) {
    if (!name.startsWith(".pgdata-test")) continue;
    try {
      fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
    } catch {
      // still in use by a stray process; ignore
    }
  }
}

export async function setup(project: TestProject) {
  removeStaleDirs();
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
    postgresFlags: ["-c", "max_connections=400", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off",
      // No io_worker processes: on Windows they can outlive the postmaster and keep the port open.
      "-c", "io_method=sync"],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  project.provide("pgAdminUrl", `postgres://postgres:postgres@localhost:${PORT}/postgres`);
}

export async function teardown() {
  await pg?.stop();
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
