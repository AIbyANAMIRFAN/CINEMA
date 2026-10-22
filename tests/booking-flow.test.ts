import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { calculateTotals } from "@/lib/pricing";
import { getBookingDetail, listUserBookings } from "@/server/catalog";
import { processStripeEvent } from "@/server/checkout";
import { buildWorld, freshDb, invariantViolations, type TestDb, type World } from "./helpers/db";
import { FakeGateway, WEBHOOK_SECRET, completedEvent, signedEvent } from "./helpers/fake-gateway";
import { checkout, getBooking, getPayment, hold, itemsOf, seatsOf, ticketsOf } from "./helpers/flow";

describe("webhook signature verification", () => {
  const gw = new FakeGateway();
  it("parses a correctly signed payload", () => {
    const e = signedEvent("checkout.session.completed", { id: "cs_test_1", object: "checkout.session" });
    const ev = gw.constructWebhookEvent(e.payload, e.header);
    expect(ev.id).toBe(e.id);
    expect(ev.type).toBe("checkout.session.completed");
  });

  it("rejects a bad signature, wrong secret and a tampered payload", () => {
    const e = signedEvent("checkout.session.completed", { id: "cs_test_1", object: "checkout.session" });
    expect(() => gw.constructWebhookEvent(e.payload, "t=1,v1=deadbeef")).toThrow(Stripe.errors.StripeSignatureVerificationError);
    const other = new Stripe("sk_test_x").webhooks.generateTestHeaderString({ payload: e.payload, secret: "whsec_other" });
    expect(() => gw.constructWebhookEvent(e.payload, other)).toThrow();
    const tampered = e.payload.replace("cs_test_1", "cs_test_2");
    expect(() => gw.constructWebhookEvent(tampered, e.header)).toThrow();
    expect(WEBHOOK_SECRET).toMatch(/^whsec_/);
  });
});

describe("full booking flow", () => {
  let t: TestDb;
  let w: World;
  const gw = new FakeGateway();
  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db);
  });
  afterAll(() => t.close());

  it("hold -> checkout -> signed webhook -> CONFIRMED with one ticket", async () => {
    // A1 accessible (1250), A2 standard (1250), D8 premium (1750)
    const seatIds = [w.seatIds[0], w.seatIds[1], w.seatIds[31]];
    const h = await hold(t.db, w.alice, w.showtime.id, seatIds);
    expect(h.status).toBe("PENDING");
    expect(h.replayed).toBe(false);
    expect(h.reference).toMatch(/^CB[2-9A-Z]{8}$/);
    const expected = calculateTotals([1250, 1250, 1750]);
    expect(h).toMatchObject({ ...expected, currency: "USD" });

    const held = await seatsOf(t.db, seatIds);
    expect(held.every((x) => x.status === "HELD" && x.heldByBookingId === h.bookingId)).toBe(true);

    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c.reused).toBe(false);
    expect(c.sessionId).toMatch(/^cs_test_/);
    expect(c.url).toContain(c.sessionId);
    expect(gw.calls.create).toHaveLength(1);
    const input = gw.calls.create[0];
    expect(input.amountMinor).toBe(expected.totalMinor);
    expect(input.currency).toBe("USD");
    expect(input.customerEmail).toBe(w.alice.email);
    expect(input.bookingId).toBe(h.bookingId);
    expect(input.successUrl).toContain(`/bookings/${h.bookingId}/confirmation`);
    expect(c.payment).toMatchObject({ status: "PENDING", amountMinor: expected.totalMinor, currency: "USD" });

    gw.pay(c.sessionId);
    const ev = completedEvent(gw, c.sessionId);
    const r = await processStripeEvent(t.db, gw, ev);
    expect(r).toEqual({ duplicate: false, type: "checkout.session.completed", handled: "confirmed" });

    const b = await getBooking(t.db, h.bookingId);
    expect(b.status).toBe("CONFIRMED");
    expect(b.confirmedAt).toBeInstanceOf(Date);
    const p = await getPayment(t.db, c.paymentId);
    expect(p.status).toBe("SUCCEEDED");
    expect(p.providerPaymentIntentId).toMatch(/^pi_test_/);
    const seats = await seatsOf(t.db, seatIds);
    expect(seats.every((x) => x.status === "BOOKED" && x.heldByBookingId === h.bookingId && x.holdExpiresAt === null)).toBe(true);
    expect((await itemsOf(t.db, h.bookingId)).every((i) => i.active)).toBe(true);
    const tickets = await ticketsOf(t.db, h.bookingId);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].code.length).toBeGreaterThanOrEqual(20);
    expect(tickets[0].revokedAt).toBeNull();

    const detail = await getBookingDetail(t.db, h.bookingId, { userId: w.alice.id });
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("CONFIRMED");
    expect(detail!.ticket?.code).toBe(tickets[0].code);
    expect(detail!.seats.map((x) => `${x.row}${x.number}`)).toEqual(["A1", "A2", "D8"]);
    expect(detail!.payments[0]).toMatchObject({ status: "SUCCEEDED", amountMinor: expected.totalMinor });
    expect(detail!.movieTitle).toBe(w.movie.title);
    expect(detail!.totalMinor).toBe(expected.totalMinor);

    const list = await listUserBookings(t.db, w.alice.id);
    expect(list.map((x) => x.id)).toContain(h.bookingId);
    expect(await listUserBookings(t.db, w.bob.id)).toEqual([]);

    const [evRow] = await t.db.select().from(s.webhookEvents).where(eq(s.webhookEvents.id, ev.id));
    expect(evRow.type).toBe("checkout.session.completed");
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("booked seats cannot be held by anyone else", async () => {
    const [b] = await t.db.select().from(s.bookings).where(eq(s.bookings.status, "CONFIRMED"));
    const items = await itemsOf(t.db, b.id);
    await expect(hold(t.db, w.bob, w.showtime.id, [items[0].showtimeSeatId])).rejects.toMatchObject({ code: "SEATS_UNAVAILABLE" });
  });

  it("rejects bad hold requests", async () => {
    await expect(hold(t.db, w.bob, w.showtime.id, [])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(hold(t.db, w.bob, w.showtime.id, w.seatIds.slice(2, 13))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const other = await w.addShowtime(new Date(w.showtime.startsAt.getTime() + 24 * 3600_000));
    await expect(hold(t.db, w.bob, w.showtime.id, [other.seatIds[5]])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(hold(t.db, w.bob, "00000000-0000-0000-0000-000000000000", [w.seatIds[5]])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await t.db.update(s.showtimes).set({ status: "CANCELLED" }).where(eq(s.showtimes.id, other.showtime.id));
    await expect(hold(t.db, w.bob, other.showtime.id, [other.seatIds[5]])).rejects.toMatchObject({ code: "CONFLICT" });
    // Blocked seat
    await t.db.update(s.showtimeSeats).set({ status: "BLOCKED" }).where(eq(s.showtimeSeats.id, w.seatIds[20]));
    await expect(hold(t.db, w.bob, w.showtime.id, [w.seatIds[20]])).rejects.toMatchObject({ code: "SEATS_UNAVAILABLE" });
    // Started showtime
    await expect(
      hold(t.db, w.bob, w.showtime.id, [w.seatIds[6]], new Date(w.showtime.startsAt.getTime() + 1000)),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("duplicate seat ids in one request are collapsed", async () => {
    const h = await hold(t.db, w.bob, w.showtime.id, [w.seatIds[7], w.seatIds[7]]);
    expect(h.subtotalMinor).toBe(1250);
    expect(h.feeMinor).toBe(150);
  });
});
