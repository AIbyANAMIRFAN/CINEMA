import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { CHECKOUT_HOLD_GRACE_MINUTES, CHECKOUT_SESSION_MINUTES, HOLD_MINUTES } from "@/lib/pricing";
import { releaseExpiredHolds } from "@/server/bookings";
import { getSeatMap } from "@/server/catalog";
import { HOUR, MINUTE, buildWorld, caught, freshDb, invariantViolations, type TestDb, type World } from "./helpers/db";
import { FakeGateway } from "./helpers/fake-gateway";
import { checkout, getBooking, hold, itemsOf, seatsOf } from "./helpers/flow";

describe("seat holds and expiry", () => {
  let t: TestDb;
  let w: World;
  const gw = new FakeGateway();
  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db, { rows: 6, perRow: 10 });
  });
  afterAll(() => t.close());

  it("holds expire after HOLD_MINUTES and the sweeper releases them idempotently", async () => {
    const before = Date.now();
    const h = await hold(t.db, w.alice, w.showtime.id, [w.seatIds[0], w.seatIds[1]]);
    expect(h.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(before + HOLD_MINUTES * MINUTE - 1000);
    expect(h.holdExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + HOLD_MINUTES * MINUTE + 1000);

    // Not yet expired: nothing released.
    expect((await releaseExpiredHolds(t.db)).released).toBe(0);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("PENDING");

    const later = new Date(h.holdExpiresAt.getTime() + 1000);
    const r1 = await releaseExpiredHolds(t.db, later);
    expect(r1.released).toBe(1);
    const b = await getBooking(t.db, h.bookingId);
    expect(b.status).toBe("EXPIRED");
    expect((await seatsOf(t.db, [w.seatIds[0], w.seatIds[1]])).map((x) => [x.status, x.heldByBookingId, x.holdExpiresAt])).toEqual([
      ["AVAILABLE", null, null],
      ["AVAILABLE", null, null],
    ]);
    expect((await itemsOf(t.db, h.bookingId)).every((i) => !i.active)).toBe(true);

    const r2 = await releaseExpiredHolds(t.db, later);
    expect(r2).toEqual({ released: 0, orphanedSeatsFreed: 0 });
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("two concurrent sweeper runs never double-process", async () => {
    const holds = [];
    for (let i = 0; i < 12; i++) holds.push(await hold(t.db, i % 2 ? w.alice : w.bob, w.showtime.id, [w.seatIds[10 + i]]));
    const later = new Date(Math.max(...holds.map((h) => h.holdExpiresAt.getTime())) + 1000);
    const dbs = [t.extra(2), t.extra(2), t.extra(2)];
    const results = await Promise.all(dbs.map((d) => releaseExpiredHolds(d, later, 3)));
    expect(results.reduce((a, r) => a + r.released, 0)).toBe(12);
    const audits = await t.db.execute(
      sql`select entity_id, count(*)::int as n from audit_logs where action = 'booking.expired' group by entity_id having count(*) > 1`,
    );
    expect(audits.rows).toEqual([]);
    for (const h of holds) expect((await getBooking(t.db, h.bookingId)).status).toBe("EXPIRED");
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("a new hold on a lapsed-held seat succeeds before the sweeper runs (lazy release)", async () => {
    const seat = w.seatIds[30];
    const a = await hold(t.db, w.alice, w.showtime.id, [seat, w.seatIds[31]]);
    // Bob can't take it while the hold is live...
    await expect(hold(t.db, w.bob, w.showtime.id, [seat])).rejects.toMatchObject({ code: "SEATS_UNAVAILABLE" });
    // ...but can once it has lapsed, without any sweeper.
    const later = new Date(a.holdExpiresAt.getTime() + 1000);
    const b = await hold(t.db, w.bob, w.showtime.id, [seat], later);
    expect(b.status).toBe("PENDING");
    expect((await getBooking(t.db, a.bookingId)).status).toBe("EXPIRED");
    // Alice's other seat is released too (the whole lapsed booking is released).
    const [s31] = await seatsOf(t.db, [w.seatIds[31]]);
    expect(s31.status).toBe("AVAILABLE");
    const [s30] = await seatsOf(t.db, [seat]);
    expect(s30.heldByBookingId).toBe(b.bookingId);
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("startCheckout on an expired hold -> HOLD_EXPIRED and the booking is released", async () => {
    const h = await hold(t.db, w.alice, w.showtime.id, [w.seatIds[40]]);
    const later = new Date(h.holdExpiresAt.getTime() + 1000);
    const e = await caught(() => checkout(t.db, gw, w.alice, h.bookingId, later));
    expect(e.code).toBe("HOLD_EXPIRED");
    expect(e.status).toBe(410);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("EXPIRED");
    const [seat] = await seatsOf(t.db, [w.seatIds[40]]);
    expect(seat.status).toBe("AVAILABLE");
    expect(gw.calls.create.filter((c) => c.bookingId === h.bookingId)).toHaveLength(0);
    // Paying for an expired booking is refused.
    const again = await caught(() => checkout(t.db, gw, w.alice, h.bookingId));
    expect(again.code).toBe("CONFLICT");
  });

  it("checkout extends the hold to cover the payment session", async () => {
    const h = await hold(t.db, w.alice, w.showtime.id, [w.seatIds[41], w.seatIds[42]]);
    const started = Date.now();
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const input = gw.calls.create.at(-1)!;
    expect(input.expiresAt.getTime()).toBeGreaterThanOrEqual(started + CHECKOUT_SESSION_MINUTES * MINUTE);
    const b = await getBooking(t.db, h.bookingId);
    expect(b.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(input.expiresAt.getTime() + CHECKOUT_HOLD_GRACE_MINUTES * MINUTE - 1000);
    const seats = await seatsOf(t.db, [w.seatIds[41], w.seatIds[42]]);
    for (const x of seats) expect(x.holdExpiresAt!.getTime()).toBe(b.holdExpiresAt.getTime());
    // Original 10-minute expiry passing no longer releases the seats.
    const afterOriginal = new Date(h.holdExpiresAt.getTime() + 60_000);
    await releaseExpiredHolds(t.db, afterOriginal);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("PENDING");
    const map = await getSeatMap(t.db, w.showtime.id, w.alice.id, afterOriginal);
    expect(map.find((x) => x.id === w.seatIds[41])).toMatchObject({ status: "HELD", mine: true });
    expect(c.reused).toBe(false);
  });

  it("orphaned HELD seats (booking gone) are freed by the defensive sweep", async () => {
    const h = await hold(t.db, w.alice, w.showtime.id, [w.seatIds[50]]);
    // Simulate inconsistent state: booking marked EXPIRED behind the service's back.
    await t.db.execute(sql`update bookings set status = 'EXPIRED' where id = ${h.bookingId}`);
    await t.db.update(s.bookingItems).set({ active: false }).where(eq(s.bookingItems.bookingId, h.bookingId));
    const r = await releaseExpiredHolds(t.db, new Date(Date.now() + 2 * HOUR));
    expect(r.orphanedSeatsFreed).toBeGreaterThanOrEqual(1);
    const [seat] = await seatsOf(t.db, [w.seatIds[50]]);
    expect(seat.status).toBe("AVAILABLE");
  });
});
