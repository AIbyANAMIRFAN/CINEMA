import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import type { Pool } from "pg";
import { createDb, createPool, type Database } from "./client";

// One pool per function instance. DATABASE_URL is Neon's pooled (PgBouncer) connection string.
const globalForDb = globalThis as unknown as { cinebookPool?: Pool; cinebookDb?: Database };

function init(): Database {
  if (globalForDb.cinebookDb) return globalForDb.cinebookDb;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const pool = createPool(url);
  // Lets Vercel Fluid compute close idle clients before an instance is suspended.
  attachDatabasePool(pool);
  globalForDb.cinebookPool = pool;
  globalForDb.cinebookDb = createDb(pool);
  return globalForDb.cinebookDb;
}

export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    const real = init() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

export * as schema from "./schema";
