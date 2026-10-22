import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

// One real PostgreSQL 18 instance for the whole test run. Each test file creates its own database.
const PORT = 54330;
const DATA_DIR = path.resolve(".pgdata-test");

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let pg: EmbeddedPostgres | undefined;

export async function setup(project: TestProject) {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
    postgresFlags: ["-c", "max_connections=400", "-c", "fsync=off", "-c", "synchronous_commit=off"],
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  project.provide("pgAdminUrl", `postgres://postgres:postgres@localhost:${PORT}/postgres`);
}

export async function teardown() {
  await pg?.stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
