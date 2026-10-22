import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@/db/client";
import { MIGRATIONS, buildWorld, createEmptyDatabase, freshDb, runMigrations, type TestDb } from "./helpers/db";

const REQUIRED_TABLES = [
  "users",
  "genres",
  "movies",
  "movie_genres",
  "cinemas",
  "auditoriums",
  "seats",
  "showtimes",
  "showtime_seats",
  "bookings",
  "booking_items",
  "payments",
  "tickets",
  "audit_logs",
  "webhook_events",
];

/** Run a statement in a savepoint and return the Postgres error (code + constraint), or null. */
async function pgErr(t: TestDb, statement: ReturnType<typeof sql>) {
  const client = await t.pool.connect();
  try {
    await client.query("begin");
    const db = drizzle(client);
    await db.execute(statement);
    return null;
  } catch (e: any) {
    const c = e.cause ?? e;
    return { code: c.code as string, constraint: c.constraint as string | undefined, message: c.message as string };
  } finally {
    await client.query("rollback");
    client.release();
  }
}

describe("migrations on a clean database", () => {
  let t: TestDb;
  let w: Awaited<ReturnType<typeof buildWorld>>;

  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db);
  });
  afterAll(() => t.close());

  it("creates all 14 required tables plus webhook_events", async () => {
    const r = await t.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    const names = r.rows.map((x: any) => x.table_name);
    for (const table of REQUIRED_TABLES) expect(names, table).toContain(table);
  });

  it("re-running migrate is a no-op", async () => {
    const before = await t.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    await runMigrations(t.url);
    const after = await t.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((before.rows[0] as any).n).toBeGreaterThanOrEqual(2);
  });

  it("migrations apply on a second empty database in one pass", async () => {
    const { url } = await createEmptyDatabase();
    const pool = createPool(url, 1);
    try {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
      const r = await pool.query(
        "select count(*)::int as n from information_schema.tables where table_schema='public'",
      );
      expect(r.rows[0].n).toBeGreaterThanOrEqual(15);
    } finally {
      await pool.end();
    }
  });

  it("has the key named constraints and indexes", async () => {
    const idx = await t.db.execute(sql`select indexname, indexdef from pg_indexes where schemaname='public'`);
    const byName = new Map(idx.rows.map((r: any) => [r.indexname, r.indexdef as string]));
    for (const n of [
      "auditoriums_cinema_name_uq",
      "seats_position_uq",
      "showtime_seats_showtime_seat_uq",
      "booking_items_active_seat_uq",
      "bookings_user_idempotency_uq",
      "payments_one_success_uq",
      "users_email_lower_uq",
    ]) {
      expect(byName.has(n), n).toBe(true);
    }
    expect(byName.get("booking_items_active_seat_uq")).toMatch(/UNIQUE/);
    expect(byName.get("booking_items_active_seat_uq")).toMatch(/WHERE active/);
    const ex = await t.db.execute(
      sql`select conname, contype from pg_constraint where conname = 'showtimes_no_overlap_ex'`,
    );
    expect(ex.rows).toEqual([{ conname: "showtimes_no_overlap_ex", contype: "x" }]);
  });

  it("rejects duplicate screen names within a cinema but allows them across cinemas", async () => {
    const e = await pgErr(t, sql`insert into auditoriums (cinema_id, name) values (${w.cinema.id}, 'Screen 1')`);
    expect(e?.code).toBe("23505");
    expect(e?.constraint).toBe("auditoriums_cinema_name_uq");
    const ok = await pgErr(
      t,
      sql`with c as (insert into cinemas (name, slug, city, address) values ('X','x-other','c','a') returning id)
          insert into auditoriums (cinema_id, name) select id, 'Screen 1' from c`,
    );
    expect(ok).toBeNull();
  });

  it("rejects duplicate seat positions in an auditorium", async () => {
    const e = await pgErr(
      t,
      sql`insert into seats (auditorium_id, row_label, seat_number) values (${w.auditorium.id}, 'A', 1)`,
    );
    expect(e?.constraint).toBe("seats_position_uq");
  });

  it("rejects a duplicate showtime seat", async () => {
    const e = await pgErr(
      t,
      sql`insert into showtime_seats (showtime_id, seat_id, price_minor) values (${w.showtime.id}, ${w.seatRows[0].id}, 100)`,
    );
    expect(e?.constraint).toBe("showtime_seats_showtime_seat_uq");
  });

  it("rejects overlapping SCHEDULED showtimes in one auditorium (exclusion constraint)", async () => {
    const start = new Date(w.showtime.startsAt.getTime() + 30 * 60_000);
    const end = new Date(start.getTime() + 60 * 60_000);
    const e = await pgErr(
      t,
      sql`insert into showtimes (movie_id, auditorium_id, starts_at, ends_at, base_price_minor)
          values (${w.movie.id}, ${w.auditorium.id}, ${start.toISOString()}, ${end.toISOString()}, 1000)`,
    );
    expect(e?.code).toBe("23P01");
    expect(e?.constraint).toBe("showtimes_no_overlap_ex");
    // Back-to-back (half-open range) is allowed.
    const s2 = w.showtime.endsAt;
    const ok = await pgErr(
      t,
      sql`insert into showtimes (movie_id, auditorium_id, starts_at, ends_at, base_price_minor)
          values (${w.movie.id}, ${w.auditorium.id}, ${s2.toISOString()}, ${new Date(s2.getTime() + 3600_000).toISOString()}, 1000)`,
    );
    expect(ok).toBeNull();
    // A cancelled overlapping showtime is allowed.
    const ok2 = await pgErr(
      t,
      sql`insert into showtimes (movie_id, auditorium_id, starts_at, ends_at, base_price_minor, status)
          values (${w.movie.id}, ${w.auditorium.id}, ${start.toISOString()}, ${end.toISOString()}, 1000, 'CANCELLED')`,
    );
    expect(ok2).toBeNull();
  });

  it("rejects negative prices and invalid enum values", async () => {
    const neg = await pgErr(t, sql`update showtimes set base_price_minor = -1 where id = ${w.showtime.id}`);
    expect(neg?.code).toBe("23514");
    expect(neg?.constraint).toBe("showtimes_price_ck");
    const negSeat = await pgErr(t, sql`update showtime_seats set price_minor = -5 where id = ${w.seatIds[0]}`);
    expect(negSeat?.constraint).toBe("showtime_seats_price_ck");
    const badEnum = await pgErr(t, sql`update showtime_seats set status = 'SOLD' where id = ${w.seatIds[0]}`);
    expect(badEnum?.code).toBe("22P02");
    const badRole = await pgErr(t, sql`update users set role = 'ROOT' where id = ${w.alice.id}`);
    expect(badRole?.code).toBe("22P02");
  });

  it("requires booking total = subtotal + fee + tax", async () => {
    const bad = await pgErr(
      t,
      sql`insert into bookings (reference, user_id, showtime_id, subtotal_minor, fee_minor, tax_minor, total_minor, currency, idempotency_key, hold_expires_at)
          values ('CBTEST1', ${w.alice.id}, ${w.showtime.id}, 1000, 150, 92, 1000, 'USD', 'k1', now())`,
    );
    expect(bad?.constraint).toBe("bookings_amounts_ck");
    const ok = await pgErr(
      t,
      sql`insert into bookings (reference, user_id, showtime_id, subtotal_minor, fee_minor, tax_minor, total_minor, currency, idempotency_key, hold_expires_at)
          values ('CBTEST2', ${w.alice.id}, ${w.showtime.id}, 1000, 150, 92, 1242, 'USD', 'k2', now())`,
    );
    expect(ok).toBeNull();
  });

  it("enforces seat hold consistency and the active-seat partial unique index", async () => {
    // HELD without a booking is rejected.
    const e = await pgErr(t, sql`update showtime_seats set status = 'HELD', hold_expires_at = now() where id = ${w.seatIds[0]}`);
    expect(e?.constraint).toBe("showtime_seats_hold_ck");
    // Two active booking_items for one showtime seat are rejected; inactive duplicates are fine.
    const dup = await pgErr(
      t,
      sql`with b1 as (insert into bookings (reference, user_id, showtime_id, subtotal_minor, fee_minor, tax_minor, total_minor, currency, idempotency_key, hold_expires_at)
                      values ('CBDUP1', ${w.alice.id}, ${w.showtime.id}, 0,0,0,0,'USD','d1', now()) returning id),
               b2 as (insert into bookings (reference, user_id, showtime_id, subtotal_minor, fee_minor, tax_minor, total_minor, currency, idempotency_key, hold_expires_at)
                      values ('CBDUP2', ${w.bob.id}, ${w.showtime.id}, 0,0,0,0,'USD','d2', now()) returning id)
          insert into booking_items (booking_id, showtime_seat_id, price_minor, active)
          select id, ${w.seatIds[0]}::uuid, 0, true from b1 union all select id, ${w.seatIds[0]}::uuid, 0, true from b2`,
    );
    expect(dup, JSON.stringify(dup)).not.toBeNull();
    expect(dup?.constraint, dup?.message).toBe("booking_items_active_seat_uq");
    const inactive = await pgErr(
      t,
      sql`with b1 as (insert into bookings (reference, user_id, showtime_id, subtotal_minor, fee_minor, tax_minor, total_minor, currency, idempotency_key, hold_expires_at)
                      values ('CBDUP3', ${w.alice.id}, ${w.showtime.id}, 0,0,0,0,'USD','d3', now()) returning id),
               b2 as (insert into bookings (reference, user_id, showtime_id, subtotal_minor, fee_minor, tax_minor, total_minor, currency, idempotency_key, hold_expires_at)
                      values ('CBDUP4', ${w.bob.id}, ${w.showtime.id}, 0,0,0,0,'USD','d4', now()) returning id)
          insert into booking_items (booking_id, showtime_seat_id, price_minor, active)
          select id, ${w.seatIds[0]}::uuid, 0, false from b1 union all select id, ${w.seatIds[0]}::uuid, 0, true from b2`,
    );
    expect(inactive).toBeNull();
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const e = await pgErr(
      t,
      sql`insert into users (email, name, password_hash) values (${w.alice.email.toUpperCase()}, 'x', 'h')`,
    );
    expect(e?.constraint).toBe("users_email_lower_uq");
  });
});
