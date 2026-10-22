/* eslint-disable @typescript-eslint/no-explicit-any -- tests poke at raw driver rows and errors */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, type Pool } from "pg";
import { inject } from "vitest";
import { createDb, createPool, type Database } from "@/db/client";
import * as s from "@/db/schema";
import { seatPrice, type SeatTypeName } from "@/lib/pricing";

export const MIGRATIONS = "./drizzle";

export function adminUrl() {
  return inject("pgAdminUrl");
}

export function urlFor(dbName: string) {
  const u = new URL(adminUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function createEmptyDatabase(): Promise<{ name: string; url: string }> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  const c = new Client({ connectionString: adminUrl() });
  await c.connect();
  try {
    await c.query(`create database ${name}`);
  } finally {
    await c.end();
  }
  return { name, url: urlFor(name) };
}

export async function runMigrations(url: string) {
  const pool = createPool(url, 1);
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  } finally {
    await pool.end();
  }
}

export type TestDb = {
  url: string;
  pool: Pool;
  db: Database;
  /** A separate pool + Database (its own connections), for concurrency tests. */
  extra: (max?: number) => Database;
  close: () => Promise<void>;
};

/** Fresh database with all migrations applied. */
export async function freshDb(): Promise<TestDb> {
  const { url } = await createEmptyDatabase();
  await runMigrations(url);
  const pool = createPool(url, 10);
  const pools: Pool[] = [pool];
  return {
    url,
    pool,
    db: createDb(pool),
    extra(max = 2) {
      const p = createPool(url, max);
      pools.push(p);
      return createDb(p);
    },
    async close() {
      await Promise.all(pools.map((p) => p.end().catch(() => {})));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let cheapHash: string | undefined;
export const PASSWORD = "Passw0rd!123";
async function hash() {
  return (cheapHash ??= await bcrypt.hash(PASSWORD, 4));
}

export async function createUser(db: Database, opts: { email?: string; name?: string; role?: "USER" | "ADMIN" } = {}) {
  const [u] = await db
    .insert(s.users)
    .values({
      email: opts.email ?? `u_${randomBytes(5).toString("hex")}@example.test`,
      name: opts.name ?? "Test User",
      passwordHash: await hash(),
      role: opts.role ?? "USER",
    })
    .returning();
  return u;
}

export type World = Awaited<ReturnType<typeof buildWorld>>;

export const HOUR = 3600_000;
export const MINUTE = 60_000;

/**
 * Minimal catalogue: one cinema (America/New_York), one auditorium with rows A..D x 8 seats
 * (A1 ACCESSIBLE, last row PREMIUM), one movie, one showtime starting in `startsInHours` hours,
 * and three users (alice, bob, admin).
 */
export async function buildWorld(
  db: Database,
  opts: { rows?: number; perRow?: number; basePriceMinor?: number; startsInHours?: number; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const rows = opts.rows ?? 4;
  const perRow = opts.perRow ?? 8;
  const base = opts.basePriceMinor ?? 1250;
  const tag = randomBytes(4).toString("hex");

  const [cinema] = await db
    .insert(s.cinemas)
    .values({ name: `Test Cinema ${tag}`, slug: `test-${tag}`, city: "Testville", address: "1 Test St", timezone: "America/New_York" })
    .returning();
  const [aud] = await db.insert(s.auditoriums).values({ cinemaId: cinema.id, name: "Screen 1" }).returning();
  const seatValues: (typeof s.seats.$inferInsert)[] = [];
  for (let r = 0; r < rows; r++) {
    for (let n = 1; n <= perRow; n++) {
      const type: SeatTypeName = r === 0 && n === 1 ? "ACCESSIBLE" : r === rows - 1 ? "PREMIUM" : "STANDARD";
      seatValues.push({ auditoriumId: aud.id, rowLabel: String.fromCharCode(65 + r), seatNumber: n, seatType: type });
    }
  }
  const seatRows = await db.insert(s.seats).values(seatValues).returning();
  const [movie] = await db
    .insert(s.movies)
    .values({
      title: `Test Movie ${tag}`,
      slug: `test-movie-${tag}`,
      synopsis: "A test.",
      durationMinutes: 100,
      language: "English",
      ageRating: "PG",
      releaseDate: "2026-01-01",
    })
    .returning();

  const addShowtime = async (startsAt: Date, basePriceMinor = base, auditoriumId = aud.id) => {
    const [st] = await db
      .insert(s.showtimes)
      .values({
        movieId: movie.id,
        auditoriumId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 115 * MINUTE),
        basePriceMinor,
        currency: "USD",
      })
      .returning();
    const ss = await db
      .insert(s.showtimeSeats)
      .values(seatRows.map((seat) => ({ showtimeId: st.id, seatId: seat.id, priceMinor: seatPrice(basePriceMinor, seat.seatType) })))
      .returning();
    const order = new Map(seatRows.map((seat, i) => [seat.id, i]));
    ss.sort((a, b) => order.get(a.seatId)! - order.get(b.seatId)!);
    return { showtime: st, seats: ss, seatIds: ss.map((x) => x.id) };
  };

  const first = await addShowtime(new Date(now.getTime() + (opts.startsInHours ?? 48) * HOUR));
  const alice = await createUser(db, { name: "Alice" });
  const bob = await createUser(db, { name: "Bob" });
  const admin = await createUser(db, { name: "Admin", role: "ADMIN" });
  return { cinema, auditorium: aud, seatRows, movie, ...first, addShowtime, alice, bob, admin };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Returns human-readable invariant violations (empty when the DB is consistent). */
export async function invariantViolations(db: Database): Promise<string[]> {
  const out: string[] = [];
  const q = async (label: string, query: SQL) => {
    const r = await db.execute(query);
    if (r.rows.length) out.push(`${label}: ${JSON.stringify(r.rows.slice(0, 5))}`);
  };
  await q(
    "showtime seat in two active booking items",
    sql`select showtime_seat_id, count(*) from booking_items where active group by 1 having count(*) > 1`,
  );
  await q(
    "HELD/BOOKED seat not owned by a PENDING/CONFIRMED booking",
    sql`select ss.id, ss.status, b.status as booking_status from showtime_seats ss
        left join bookings b on b.id = ss.held_by_booking_id
        where ss.status in ('HELD','BOOKED') and (b.id is null or b.status not in ('PENDING','CONFIRMED'))`,
  );
  await q(
    "HELD seat of non-PENDING booking or BOOKED seat of non-CONFIRMED booking",
    sql`select ss.id, ss.status, b.status as booking_status from showtime_seats ss join bookings b on b.id = ss.held_by_booking_id
        where (ss.status = 'HELD' and b.status <> 'PENDING') or (ss.status = 'BOOKED' and b.status <> 'CONFIRMED')`,
  );
  await q(
    "live booking whose active item count differs from its held/booked seats",
    sql`select b.id, b.status from bookings b where b.status in ('PENDING','CONFIRMED')
          and (select count(*) from booking_items bi where bi.booking_id = b.id and bi.active)
           <> (select count(*) from showtime_seats ss where ss.held_by_booking_id = b.id)`,
  );
  await q(
    "dead booking still has active items",
    sql`select b.id, b.status from bookings b where b.status not in ('PENDING','CONFIRMED')
        and exists (select 1 from booking_items bi where bi.booking_id = b.id and bi.active)`,
  );
  await q(
    "active item whose seat is not held/booked by its booking",
    sql`select bi.id from booking_items bi join showtime_seats ss on ss.id = bi.showtime_seat_id
        where bi.active and (ss.held_by_booking_id is distinct from bi.booking_id)`,
  );
  await q(
    "booking subtotal does not match its items",
    sql`select b.id from bookings b where b.subtotal_minor <>
        (select coalesce(sum(price_minor),0) from booking_items bi where bi.booking_id = b.id)`,
  );
  return out;
}

/** Run fn and return the thrown error (fails the test if nothing is thrown). */
export async function caught(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}
