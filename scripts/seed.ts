import { config } from "dotenv";
import { sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createDb, createPool } from "../src/db/client";
import { movies } from "../src/db/schema";
import { seedDatabase } from "../src/db/seed-data";

config({ path: ".env.local" });
config();

// Usage: npm run db:seed [-- --reset]
// --reset wipes ALL data (bookings included) first; refused when VERCEL_ENV=production.
async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  const reset = process.argv.includes("--reset");
  if (reset && process.env.VERCEL_ENV === "production") throw new Error("Refusing to reset a production database");

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@cinebook.test";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 8) throw new Error("SEED_ADMIN_PASSWORD (8+ chars) must be set");

  const pool = createPool(url, 2);
  const db = createDb(pool);
  try {
    if (reset) {
      await db.execute(sql`truncate audit_logs, webhook_events, tickets, payments, booking_items, showtime_seats,
        bookings, showtimes, seats, auditoriums, cinemas, movie_genres, movies, genres, users restart identity cascade`);
    }
    const [existing] = await db.select({ id: movies.id }).from(movies).limit(1);
    if (existing) {
      console.log(JSON.stringify({ level: "info", msg: "seed.skipped", reason: "catalogue not empty; use --reset" }));
      return;
    }
    const counts = await seedDatabase(db, {
      adminEmail,
      adminPasswordHash: await bcrypt.hash(adminPassword, 11),
      demoPasswordHash: process.env.SEED_DEMO_PASSWORD ? await bcrypt.hash(process.env.SEED_DEMO_PASSWORD, 11) : undefined,
      days: Number(process.env.SEED_DAYS ?? 7),
    });
    console.log(JSON.stringify({ level: "info", msg: "seed.done", ...counts }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "seed.failed", error: String(err) }));
  process.exit(1);
});
