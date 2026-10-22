/* eslint-disable @typescript-eslint/no-explicit-any -- tests poke at raw driver rows and errors */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import { AppError } from "@/lib/errors";
import { holdSeats } from "@/server/bookings";
import { buildWorld, createUser, freshDb, invariantViolations, type TestDb, type World } from "./helpers/db";
import { key } from "./helpers/flow";

type Settled = PromiseSettledResult<Awaited<ReturnType<typeof holdSeats>>>;
const ok = (r: Settled[]) => r.filter((x) => x.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof holdSeats>>>[];
const failed = (r: Settled[]) => r.filter((x) => x.status === "rejected") as PromiseRejectedResult[];

describe("concurrent seat holds", () => {
  let t: TestDb;
  let w: World;
  let dbA: Database;
  let dbB: Database;
  beforeAll(async () => {
    t = await freshDb();
    // 6 rows x 10 = 60 seats
    w = await buildWorld(t.db, { rows: 6, perRow: 10 });
    dbA = t.extra(2);
    dbB = t.extra(2);
    // Warm both pools so connections are open before the race.
    await Promise.all([dbA.execute(sql`select 1`), dbB.execute(sql`select 1`)]);
  });
  afterAll(() => t.close());

  it("two users racing for the same seat: exactly one wins, 20 rounds", async () => {
    for (let round = 0; round < 20; round++) {
      const seat = w.seatIds[round];
      const results = await Promise.allSettled([
        holdSeats(dbA, { userId: w.alice.id, showtimeId: w.showtime.id, showtimeSeatIds: [seat], idempotencyKey: key("a") }),
        holdSeats(dbB, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [seat], idempotencyKey: key("b") }),
      ]);
      expect(ok(results), `round ${round}`).toHaveLength(1);
      const [err] = failed(results);
      expect(err.reason).toBeInstanceOf(AppError);
      expect(err.reason.code).toBe("SEATS_UNAVAILABLE");
      const [row] = await t.db.select().from(s.showtimeSeats).where(eq(s.showtimeSeats.id, seat));
      expect(row.status).toBe("HELD");
      expect(row.heldByBookingId).toBe(ok(results)[0].value.bookingId);
    }
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("10-way race on overlapping seat sets keeps the database consistent", async () => {
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => createUser(t.db, { name: `Racer ${i}` })));
    const pools = users.map(() => t.extra(1));
    await Promise.all(pools.map((p) => p.execute(sql`select 1`)));
    // Seats 20..39 are free. User i asks for a window of 4 seats starting at 20 + 2i (overlapping neighbours),
    // plus everybody wants seat 39.
    const sets = users.map((_, i) => [...new Set([...w.seatIds.slice(20 + 2 * i, 24 + 2 * i), w.seatIds[39]])]);
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled(
        users.map((u, i) =>
          holdSeats(pools[i], { userId: u.id, showtimeId: w.showtime.id, showtimeSeatIds: sets[i], idempotencyKey: key(`r${round}`) }),
        ),
      );
      for (const f of failed(results)) {
        expect(f.reason).toBeInstanceOf(AppError);
        expect(f.reason.code).toBe("SEATS_UNAVAILABLE");
      }
      // Everyone wants seat 39, so at most one can win per round (and exactly one in the first round).
      if (round === 0) expect(ok(results)).toHaveLength(1);
      else expect(ok(results)).toHaveLength(0);
      expect(await invariantViolations(t.db)).toEqual([]);
    }
    // Overlapping sets without a shared seat: neighbours conflict, non-neighbours can both win.
    const sets2 = users.map((_, i) => w.seatIds.slice(40 + i, 42 + i)); // [40,41],[41,42],...
    const results = await Promise.allSettled(
      users.map((u, i) =>
        holdSeats(pools[i], { userId: u.id, showtimeId: w.showtime.id, showtimeSeatIds: sets2[i], idempotencyKey: key("s2") }),
      ),
    );
    for (const f of failed(results)) expect(f.reason.code).toBe("SEATS_UNAVAILABLE");
    const winners = ok(results).map((r) => r.value.bookingId);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    expect(winners.length).toBeLessThanOrEqual(5);
    expect(await invariantViolations(t.db)).toEqual([]);

    // Seat counts are consistent: held seats = 2 per winning booking.
    const held = await t.db.execute(
      sql`select count(*)::int as n from showtime_seats where status = 'HELD' and held_by_booking_id = any(${sql.raw(
        `array[${winners.map((id) => `'${id}'::uuid`).join(",")}]`,
      )})`,
    );
    expect((held.rows[0] as any).n).toBe(winners.length * 2);
    const active = await t.db.execute(sql`select count(*)::int as n from booking_items where active`);
    const heldOrBooked = await t.db.execute(
      sql`select count(*)::int as n from showtime_seats where status in ('HELD','BOOKED')`,
    );
    expect((active.rows[0] as any).n).toBe((heldOrBooked.rows[0] as any).n);
  });

  it("same user + same idempotency key fired concurrently -> one booking, same id for both", async () => {
    const st = await w.addShowtime(new Date(w.showtime.startsAt.getTime() + 3 * 24 * 3600_000));
    const k = key("same");
    for (let round = 0; round < 10; round++) {
      const seatSet = [st.seatIds[round * 2], st.seatIds[round * 2 + 1]];
      const kk = `${k}-${round}`;
      const results = await Promise.allSettled([
        holdSeats(dbA, { userId: w.alice.id, showtimeId: st.showtime.id, showtimeSeatIds: seatSet, idempotencyKey: kk }),
        holdSeats(dbB, { userId: w.alice.id, showtimeId: st.showtime.id, showtimeSeatIds: seatSet, idempotencyKey: kk }),
      ]);
      const errs = failed(results).map((f) => `${f.reason?.code ?? ""} ${f.reason?.message}`);
      expect(errs, `round ${round}`).toEqual([]);
      const [a, b] = ok(results).map((r) => r.value);
      expect(a.bookingId).toBe(b.bookingId);
      expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
      const rows = await t.db.select().from(s.bookings).where(eq(s.bookings.idempotencyKey, kk));
      expect(rows).toHaveLength(1);
    }
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("same key with different seats -> CONFLICT (sequential and concurrent)", async () => {
    const st = await w.addShowtime(new Date(w.showtime.startsAt.getTime() + 4 * 24 * 3600_000));
    w = { ...w, showtime: st.showtime, seatIds: st.seatIds };
    const k = key("diff");
    await holdSeats(t.db, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[45]], idempotencyKey: k });
    await expect(
      holdSeats(t.db, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[46]], idempotencyKey: k }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Same key replay with the same seats is a replay, not a new booking.
    const again = await holdSeats(t.db, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[45]], idempotencyKey: k });
    expect(again.replayed).toBe(true);

    const k2 = key("diff2");
    const results = await Promise.allSettled([
      holdSeats(dbA, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[47]], idempotencyKey: k2 }),
      holdSeats(dbB, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[48]], idempotencyKey: k2 }),
    ]);
    expect(ok(results)).toHaveLength(1);
    expect(failed(results)[0].reason.code).toBe("CONFLICT");
    const rows = await t.db.select().from(s.bookings).where(eq(s.bookings.idempotencyKey, k2));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ok(results)[0].value.bookingId);
    // Only the winner's seat is held; the loser's seat stays available.
    const seatRows = await t.db.select().from(s.showtimeSeats).where(eq(s.showtimeSeats.showtimeId, st.showtime.id));
    const heldIds = seatRows.filter((x) => x.status === "HELD").map((x) => x.id).sort();
    expect(heldIds).toHaveLength(2); // seat 45 from the sequential part + the concurrent winner
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("the same idempotency key is scoped per user", async () => {
    const k = key("scoped");
    const a = await holdSeats(t.db, { userId: w.alice.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[58]], idempotencyKey: k });
    const b = await holdSeats(t.db, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[59]], idempotencyKey: k });
    expect(a.bookingId).not.toBe(b.bookingId);
    // Bob cannot "replay" Alice's booking by reusing her key with her seats.
    await expect(
      holdSeats(t.db, { userId: w.bob.id, showtimeId: w.showtime.id, showtimeSeatIds: [w.seatIds[58]], idempotencyKey: k }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
