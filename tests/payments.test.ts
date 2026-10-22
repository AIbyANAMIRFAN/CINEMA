/* eslint-disable @typescript-eslint/no-explicit-any -- tests poke at raw driver rows and errors */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { calculateTotals } from "@/lib/pricing";
import { cancelBooking, releaseExpiredHolds } from "@/server/bookings";
import { confirmFromRedirect, processStripeEvent } from "@/server/checkout";
import { buildWorld, freshDb, invariantViolations, type TestDb, type World } from "./helpers/db";
import { FakeGateway, completedEvent, verifiedEvent } from "./helpers/fake-gateway";
import { bookAndPay, checkout, getBooking, getPayment, hold, itemsOf, seatsOf, ticketsOf } from "./helpers/flow";

describe("payments", () => {
  let t: TestDb;
  let w: World;
  let gw: FakeGateway;
  let seatCursor = 0;
  const nextSeats = (n: number) => {
    const out = w.seatIds.slice(seatCursor, seatCursor + n);
    seatCursor += n;
    if (out.length !== n) throw new Error("fixture ran out of seats");
    return out;
  };

  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db, { rows: 10, perRow: 10 });
  });
  afterAll(() => t.close());
  // Each test creates a fresh FakeGateway so call counts are per scenario.

  it("totals: booking amounts match calculateTotals and the checkout amount equals the total", async () => {
    gw = new FakeGateway();
    // last row is PREMIUM (1750), first seat ACCESSIBLE (1250)
    const seats = [w.seatIds[0], w.seatIds[95], w.seatIds[96]];
    const h = await hold(t.db, w.alice, w.showtime.id, seats);
    const prices = (await seatsOf(t.db, seats)).map((x) => x.priceMinor).sort();
    expect(prices).toEqual([1250, 1750, 1750]);
    const expected = calculateTotals(prices);
    const b = await getBooking(t.db, h.bookingId);
    expect(b).toMatchObject(expected);
    expect(b.totalMinor).toBe(b.subtotalMinor + b.feeMinor + b.taxMinor);
    const items = await itemsOf(t.db, h.bookingId);
    expect(items.reduce((a, i) => a + i.priceMinor, 0)).toBe(b.subtotalMinor);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(gw.calls.create[0].amountMinor).toBe(b.totalMinor);
    expect(c.payment.amountMinor).toBe(b.totalMinor);
    expect(gw.sessions.get(c.sessionId)!.amountTotal).toBe(b.totalMinor);
    // clean up: cancel
    await cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false });
  });

  it("success: paid session confirms; unpaid completed session is ignored", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(2));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    // completed but unpaid (e.g. async payment method pending)
    gw.pay(c.sessionId, { paymentStatus: "unpaid" });
    const r0 = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect(r0.handled).toBe("ignored");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("PENDING");
    gw.pay(c.sessionId);
    const r = await processStripeEvent(t.db, gw, verifiedEvent(gw, "checkout.session.async_payment_succeeded", gw.sessionObject(c.sessionId)));
    expect(r.handled).toBe("confirmed");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("CONFIRMED");
    expect((await getPayment(t.db, c.paymentId)).status).toBe("SUCCEEDED");
  });

  it("failure then retry: payment FAILED, booking stays PENDING, new attempt succeeds", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c1 = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.pay(c1.sessionId, { paymentStatus: "unpaid" });
    const pi = gw.sessions.get(c1.sessionId)!.paymentIntentId!;
    const failEv = verifiedEvent(gw, "payment_intent.payment_failed", {
      id: pi,
      object: "payment_intent",
      metadata: { bookingId: h.bookingId, paymentId: c1.paymentId },
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    });
    const r = await processStripeEvent(t.db, gw, failEv);
    expect(r.handled).toBe("payment_failed");
    const p1 = await getPayment(t.db, c1.paymentId);
    expect(p1.status).toBe("FAILED");
    expect(p1.failureReason).toBe("Your card was declined.");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("PENDING");

    const c2 = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c2.reused).toBe(false);
    expect(c2.paymentId).not.toBe(c1.paymentId);
    expect(c2.sessionId).not.toBe(c1.sessionId);
    expect(gw.calls.create).toHaveLength(2);
    expect(gw.calls.create[0].idempotencyKey).not.toBe(gw.calls.create[1].idempotencyKey);
    gw.pay(c2.sessionId);
    const r2 = await processStripeEvent(t.db, gw, completedEvent(gw, c2.sessionId));
    expect(r2.handled).toBe("confirmed");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("CONFIRMED");
    expect((await getPayment(t.db, c1.paymentId)).status).toBe("FAILED");
    expect((await getPayment(t.db, c2.paymentId)).status).toBe("SUCCEEDED");
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(1);
  });

  it("card declined then paid on the same session; a late failure event cannot undo success", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.pay(c.sessionId, { paymentStatus: "unpaid" });
    const pi = gw.sessions.get(c.sessionId)!.paymentIntentId!;
    const failObj = { id: pi, object: "payment_intent", metadata: { paymentId: c.paymentId }, last_payment_error: { code: "card_declined" } };
    await processStripeEvent(t.db, gw, verifiedEvent(gw, "payment_intent.payment_failed", failObj));
    expect((await getPayment(t.db, c.paymentId)).status).toBe("FAILED");
    gw.pay(c.sessionId);
    expect((await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId))).handled).toBe("confirmed");
    expect((await getPayment(t.db, c.paymentId)).status).toBe("SUCCEEDED");
    // Out-of-order failure delivered after success is a no-op.
    await processStripeEvent(t.db, gw, verifiedEvent(gw, "payment_intent.payment_failed", failObj));
    expect((await getPayment(t.db, c.paymentId)).status).toBe("SUCCEEDED");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("CONFIRMED");
  });

  it("async payment failure marks the payment FAILED", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const r = await processStripeEvent(t.db, gw, verifiedEvent(gw, "checkout.session.async_payment_failed", gw.sessionObject(c.sessionId)));
    expect(r.handled).toBe("payment_failed");
    expect((await getPayment(t.db, c.paymentId)).status).toBe("FAILED");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("PENDING");
  });

  it("user cancels a pending booking: seats released, session expired at the provider", async () => {
    gw = new FakeGateway();
    const seats = nextSeats(2);
    const h = await hold(t.db, w.alice, w.showtime.id, seats);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const r = await cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false });
    expect(r).toEqual({ status: "CANCELLED", refundedMinor: 0 });
    expect((await getBooking(t.db, h.bookingId)).status).toBe("CANCELLED");
    expect((await seatsOf(t.db, seats)).every((x) => x.status === "AVAILABLE")).toBe(true);
    expect(gw.calls.expire).toEqual([c.sessionId]);
    expect(gw.sessions.get(c.sessionId)!.status).toBe("expired");
    const p = await getPayment(t.db, c.paymentId);
    expect(p.status).toBe("CANCELLED");
    // checkout.session.expired webhook afterwards is harmless
    const ev = await processStripeEvent(t.db, gw, verifiedEvent(gw, "checkout.session.expired", gw.sessionObject(c.sessionId)));
    expect(ev.handled).toBe("session_expired");
    expect((await getPayment(t.db, c.paymentId)).status).toBe("CANCELLED");
    // cancelling twice -> NOT_CANCELLABLE
    await expect(cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false })).rejects.toMatchObject({
      code: "NOT_CANCELLABLE",
    });
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("checkout.session.expired marks an abandoned payment CANCELLED; retry opens a new session", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.sessions.get(c.sessionId)!.status = "expired";
    const r = await processStripeEvent(t.db, gw, verifiedEvent(gw, "checkout.session.expired", gw.sessionObject(c.sessionId)));
    expect(r.handled).toBe("session_expired");
    const p = await getPayment(t.db, c.paymentId);
    expect(p.status).toBe("CANCELLED");
    expect(p.failureReason).toBe("checkout_expired");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("PENDING");
    const c2 = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c2.reused).toBe(false);
    expect(c2.sessionId).not.toBe(c.sessionId);
  });

  it("retry reuse: startCheckout twice while the session is open reuses it", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c1 = await checkout(t.db, gw, w.alice, h.bookingId);
    const c2 = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c2.reused).toBe(true);
    expect(c2.url).toBe(c1.url);
    expect(c2.paymentId).toBe(c1.paymentId);
    expect(gw.calls.create).toHaveLength(1);
    const pays = await t.db.select().from(s.payments).where(eq(s.payments.bookingId, h.bookingId));
    expect(pays).toHaveLength(1);
    // If the provider expired it without a webhook, a new session is created and the old row is cancelled.
    gw.sessions.get(c1.sessionId)!.status = "expired";
    const c3 = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c3.reused).toBe(false);
    expect((await getPayment(t.db, c1.paymentId)).status).toBe("CANCELLED");
  });

  it("[BUG-4] concurrent startCheckout calls (double click) create only one provider session", async () => {
    gw = new FakeGateway();
    gw.createDelayMs = 150; // realistic provider latency
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const dbs = [t.extra(1), t.extra(1), t.extra(1)];
    // Three clicks 40ms apart, all while the first session is still being created at the provider.
    const res = await Promise.allSettled(
      dbs.map((d, i) => new Promise((r) => setTimeout(r, i * 40)).then(() => checkout(d, gw, w.alice, h.bookingId))),
    );
    const okUrls = new Set(res.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<any>).value.url));
    for (const r of res) if (r.status === "rejected") expect(r.reason.code).toBe("CONFLICT");
    expect(okUrls.size).toBe(1);
    const sessionsForBooking = [...gw.sessions.values()].filter((x) => x.metadata.bookingId === h.bookingId);
    expect(sessionsForBooking).toHaveLength(1);
  });

  it("provider outage on checkout -> PAYMENT_ERROR, payment FAILED, booking still payable", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    gw.failCreate = true;
    await expect(checkout(t.db, gw, w.alice, h.bookingId)).rejects.toMatchObject({ code: "PAYMENT_ERROR" });
    const [p] = await t.db.select().from(s.payments).where(eq(s.payments.bookingId, h.bookingId));
    expect(p).toMatchObject({ status: "FAILED", failureReason: "provider_error" });
    gw.failCreate = false;
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c.reused).toBe(false);
  });

  it("duplicate webhook delivery (sequential): one confirmation, one ticket, duplicate: true", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(2));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.pay(c.sessionId);
    const ev = completedEvent(gw, c.sessionId);
    const r1 = await processStripeEvent(t.db, gw, ev);
    const r2 = await processStripeEvent(t.db, gw, ev);
    expect(r1).toMatchObject({ duplicate: false, handled: "confirmed" });
    expect(r2).toMatchObject({ duplicate: true });
    // A *different* event for the same session (e.g. success-page fallback) is also a no-op.
    const r3 = await confirmFromRedirect(t.db, gw, { bookingId: h.bookingId, userId: w.alice.id, sessionId: c.sessionId });
    expect(r3).toEqual({ outcome: "already_confirmed", bookingId: h.bookingId });
    const r4 = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect(r4).toMatchObject({ duplicate: false, handled: "already_confirmed" });
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(1);
    const audits = await t.db.execute(sql`select count(*)::int as n from audit_logs where action = 'booking.confirmed' and entity_id = ${h.bookingId}`);
    expect((audits.rows[0] as any).n).toBe(1);
    expect(gw.calls.refund).toHaveLength(0);
  });

  it("duplicate webhook delivery (concurrent): one confirmation, one ticket", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(2));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.pay(c.sessionId);
    const ev = completedEvent(gw, c.sessionId);
    const dbs = [t.extra(2), t.extra(2), t.extra(2), t.extra(2)];
    const results = await Promise.all(dbs.map((d) => processStripeEvent(d, gw, ev)));
    const handled = results.filter((r) => !r.duplicate).map((r) => r.handled);
    expect(handled.filter((x) => x === "confirmed")).toHaveLength(1);
    for (const x of handled) expect(["confirmed", "already_confirmed"]).toContain(x);
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(1);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("CONFIRMED");
    const ok = await t.db.select().from(s.payments).where(and(eq(s.payments.bookingId, h.bookingId), eq(s.payments.status, "SUCCEEDED")));
    expect(ok).toHaveLength(1);
    const evRows = await t.db.select().from(s.webhookEvents).where(eq(s.webhookEvents.id, ev.id));
    expect(evRows).toHaveLength(1);
    // A later redelivery is flagged duplicate.
    expect((await processStripeEvent(t.db, gw, ev)).duplicate).toBe(true);
    expect(gw.calls.refund).toHaveLength(0);
  });

  it("payment after the hold lapsed and the seats were resold -> refund_required, refund exactly once", async () => {
    gw = new FakeGateway();
    const seats = nextSeats(2);
    const h = await hold(t.db, w.alice, w.showtime.id, seats);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const b0 = await getBooking(t.db, h.bookingId);
    // Hold (incl. checkout extension) lapses; Bob takes one of the seats.
    const later = new Date(b0.holdExpiresAt.getTime() + 1000);
    const bob = await hold(t.db, w.bob, w.showtime.id, [seats[0]], later);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("EXPIRED");

    gw.pay(c.sessionId);
    const ev = completedEvent(gw, c.sessionId);
    const r = await processStripeEvent(t.db, gw, ev);
    expect(r.handled).toBe("refund_required");
    expect(gw.calls.refund).toHaveLength(1);
    expect(gw.calls.refund[0]).toMatchObject({
      paymentIntentId: gw.sessions.get(c.sessionId)!.paymentIntentId,
      amountMinor: b0.totalMinor,
      idempotencyKey: `refund:${c.paymentId}`,
    });
    const p = await getPayment(t.db, c.paymentId);
    expect(p.status).toBe("REFUNDED");
    expect(p.providerRefundId).toMatch(/^re_test_/);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("EXPIRED");
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(0);

    // Redelivery (same event, a new event id for the same session, and the redirect fallback).
    expect((await processStripeEvent(t.db, gw, ev)).duplicate).toBe(true);
    const r2 = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect(r2.handled).toBe("ignored");
    const r3 = await confirmFromRedirect(t.db, gw, { bookingId: h.bookingId, userId: w.alice.id, sessionId: c.sessionId });
    expect(r3.outcome).toBe("ignored");
    expect(gw.calls.refund).toHaveLength(1);
    expect(gw.uniqueRefunds).toBe(1);

    // Bob's booking is untouched.
    const bb = await getBooking(t.db, bob.bookingId);
    expect(bb.status).toBe("PENDING");
    const [bs] = await seatsOf(t.db, [seats[0]]);
    expect(bs).toMatchObject({ status: "HELD", heldByBookingId: bob.bookingId });
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("concurrent redelivery of a payment that needs a refund refunds only once (by idempotency key)", async () => {
    gw = new FakeGateway();
    const seats = nextSeats(1);
    const h = await hold(t.db, w.alice, w.showtime.id, seats);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const b0 = await getBooking(t.db, h.bookingId);
    await hold(t.db, w.bob, w.showtime.id, seats, new Date(b0.holdExpiresAt.getTime() + 1000));
    gw.pay(c.sessionId);
    const evs = [completedEvent(gw, c.sessionId), completedEvent(gw, c.sessionId), completedEvent(gw, c.sessionId)];
    const dbs = evs.map(() => t.extra(2));
    await Promise.all(evs.map((e, i) => processStripeEvent(dbs[i], gw, e)));
    expect(gw.uniqueRefunds).toBe(1);
    expect(new Set(gw.calls.refund.map((r) => r.idempotencyKey))).toEqual(new Set([`refund:${c.paymentId}`]));
    expect((await getPayment(t.db, c.paymentId)).status).toBe("REFUNDED");
  });

  it("payment after the hold lapsed but seats still free -> booking recovered to CONFIRMED", async () => {
    gw = new FakeGateway();
    const seats = nextSeats(2);
    const h = await hold(t.db, w.alice, w.showtime.id, seats);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const b0 = await getBooking(t.db, h.bookingId);
    await releaseExpiredHolds(t.db, new Date(b0.holdExpiresAt.getTime() + 1000));
    expect((await getBooking(t.db, h.bookingId)).status).toBe("EXPIRED");
    expect((await getPayment(t.db, c.paymentId)).status).toBe("CANCELLED");

    gw.pay(c.sessionId);
    const r = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect(r.handled).toBe("confirmed");
    const b = await getBooking(t.db, h.bookingId);
    expect(b.status).toBe("CONFIRMED");
    expect(b.cancelledAt).toBeNull();
    expect((await getPayment(t.db, c.paymentId)).status).toBe("SUCCEEDED");
    expect((await seatsOf(t.db, seats)).every((x) => x.status === "BOOKED" && x.heldByBookingId === h.bookingId)).toBe(true);
    expect((await itemsOf(t.db, h.bookingId)).every((i) => i.active)).toBe(true);
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(1);
    expect(gw.calls.refund).toHaveLength(0);
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("amount mismatch -> refund, booking not confirmed", async () => {
    gw = new FakeGateway();
    const seats = nextSeats(1);
    const h = await hold(t.db, w.alice, w.showtime.id, seats);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.pay(c.sessionId, { amountTotal: 1 });
    const r = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect(r.handled).toBe("refund_required");
    expect(gw.calls.refund).toHaveLength(1);
    expect(gw.calls.refund[0].amountMinor).toBe(h.totalMinor);
    expect((await getPayment(t.db, c.paymentId)).status).toBe("REFUNDED");
    expect((await getBooking(t.db, h.bookingId)).status).not.toBe("CONFIRMED");
    expect((await seatsOf(t.db, seats))[0].status).toBe("AVAILABLE");
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(0);
  });

  it("currency mismatch -> refund", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    gw.pay(c.sessionId, { currency: "eur" });
    const r = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect(r.handled).toBe("refund_required");
    expect(gw.uniqueRefunds).toBe(1);
  });

  it("second paid session for an already-confirmed booking is refunded (no double charge)", async () => {
    gw = new FakeGateway();
    const h = await hold(t.db, w.alice, w.showtime.id, nextSeats(1));
    const c1 = await checkout(t.db, gw, w.alice, h.bookingId);
    // The first session expires at the provider; the customer opens a second one, then both get paid.
    gw.sessions.get(c1.sessionId)!.status = "expired";
    const c2 = await checkout(t.db, gw, w.alice, h.bookingId);
    expect(c2.sessionId).not.toBe(c1.sessionId);
    gw.pay(c2.sessionId);
    expect((await processStripeEvent(t.db, gw, completedEvent(gw, c2.sessionId))).handled).toBe("confirmed");
    gw.pay(c1.sessionId);
    const r = await processStripeEvent(t.db, gw, completedEvent(gw, c1.sessionId));
    expect(r.handled).toBe("refund_required");
    expect((await getPayment(t.db, c1.paymentId)).status).toBe("REFUNDED");
    expect((await getPayment(t.db, c2.paymentId)).status).toBe("SUCCEEDED");
    const b = await getBooking(t.db, h.bookingId);
    expect(b.status).toBe("CONFIRMED");
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(1);
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("unknown session in a webhook is ignored and recorded", async () => {
    gw = new FakeGateway();
    const ev = verifiedEvent(gw, "checkout.session.completed", {
      id: "cs_test_unknown",
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_test_unknown",
      amount_total: 100,
      currency: "usd",
      metadata: {},
    });
    const r = await processStripeEvent(t.db, gw, ev);
    expect(r).toMatchObject({ duplicate: false, handled: "ignored" });
    // Unhandled event types are acknowledged.
    const other = await processStripeEvent(t.db, gw, verifiedEvent(gw, "customer.created", { id: "cus_1", object: "customer" }));
    expect(other.handled).toBe("ignored");
  });

  it("bookAndPay helper end-to-end sanity", async () => {
    gw = new FakeGateway();
    const r = await bookAndPay(t.db, gw, w.bob, w.showtime.id, nextSeats(1));
    expect(r.result.handled).toBe("confirmed");
  });
});
