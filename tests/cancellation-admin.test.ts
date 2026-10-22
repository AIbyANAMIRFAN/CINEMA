import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as s from "@/db/schema";
import { seatPrice } from "@/lib/pricing";
import { adminListBookings, adminListMovies, adminStats, cancelShowtime, createMovie, createShowtime, setSeatBlocked, updateMovie } from "@/server/admin";
import { cancelBooking, releaseExpiredHolds } from "@/server/bookings";
import { findTicketByCode, getBookingDetail } from "@/server/catalog";
import { confirmFromRedirect, processStripeEvent, startCheckout } from "@/server/checkout";
import { HOUR, MINUTE, buildWorld, caught, freshDb, invariantViolations, type TestDb, type World } from "./helpers/db";
import { FakeGateway, completedEvent, verifiedEvent } from "./helpers/fake-gateway";
import { APP_URL, bookAndPay, checkout, getBooking, getPayment, hold, itemsOf, seatsOf, ticketsOf } from "./helpers/flow";

describe("cancellation and refunds", () => {
  let t: TestDb;
  let w: World;
  let soon: Awaited<ReturnType<World["addShowtime"]>>;
  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db, { startsInHours: 48 });
    soon = await w.addShowtime(new Date(Date.now() + 90 * MINUTE)); // inside the 2h cutoff
  });
  afterAll(() => t.close());

  it("confirmed booking cancelled > 2h before the show is REFUNDED, seats freed, ticket revoked", async () => {
    const gw = new FakeGateway();
    const seats = [w.seatIds[0], w.seatIds[1]];
    const { hold: h, checkout: c } = await bookAndPay(t.db, gw, w.alice, w.showtime.id, seats);
    const r = await cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false });
    expect(r).toEqual({ status: "REFUNDED", refundedMinor: h.totalMinor });
    expect(gw.calls.refund).toHaveLength(1);
    expect(gw.calls.refund[0]).toMatchObject({ idempotencyKey: `refund:${c.paymentId}`, amountMinor: h.totalMinor });
    const b = await getBooking(t.db, h.bookingId);
    expect(b.status).toBe("REFUNDED");
    expect(b.cancelledAt).toBeInstanceOf(Date);
    const p = await getPayment(t.db, c.paymentId);
    expect(p.status).toBe("REFUNDED");
    expect(p.providerRefundId).toMatch(/^re_test_/);
    expect((await seatsOf(t.db, seats)).every((x) => x.status === "AVAILABLE" && !x.heldByBookingId)).toBe(true);
    expect((await itemsOf(t.db, h.bookingId)).every((i) => !i.active)).toBe(true);
    const [ticket] = await ticketsOf(t.db, h.bookingId);
    expect(ticket.revokedAt).toBeInstanceOf(Date);

    // charge.refunded webhook afterwards finalises idempotently
    const pi = p.providerPaymentIntentId!;
    const ev = verifiedEvent(gw, "charge.refunded", { id: "ch_test_1", object: "charge", payment_intent: pi, refunded: true });
    const r1 = await processStripeEvent(t.db, gw, ev);
    expect(r1.handled).toBe("refund_recorded");
    expect((await processStripeEvent(t.db, gw, ev)).duplicate).toBe(true);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("REFUNDED");
    expect((await getPayment(t.db, c.paymentId)).providerRefundId).toBe(p.providerRefundId);

    // Cancelling again is refused; no second refund.
    await expect(cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false })).rejects.toMatchObject({
      code: "NOT_CANCELLABLE",
    });
    expect(gw.calls.refund).toHaveLength(1);
    // Seats can be re-sold.
    const again = await hold(t.db, w.bob, w.showtime.id, seats);
    expect(again.status).toBe("PENDING");
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("concurrent cancellations refund once (same idempotency key)", async () => {
    const gw = new FakeGateway();
    const { hold: h } = await bookAndPay(t.db, gw, w.alice, w.showtime.id, [w.seatIds[5]]);
    const dbs = [t.extra(2), t.extra(2)];
    const res = await Promise.allSettled(
      dbs.map((d) => cancelBooking(d, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false })),
    );
    for (const r of res) if (r.status === "rejected") expect(r.reason.code).toBe("NOT_CANCELLABLE");
    expect(gw.uniqueRefunds).toBe(1);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("REFUNDED");
  });

  it("charge.refunded from the provider dashboard refunds a confirmed booking", async () => {
    const gw = new FakeGateway();
    const { hold: h, checkout: c } = await bookAndPay(t.db, gw, w.alice, w.showtime.id, [w.seatIds[6]]);
    const p = await getPayment(t.db, c.paymentId);
    const ev = verifiedEvent(gw, "charge.refunded", { id: "ch_test_2", object: "charge", payment_intent: p.providerPaymentIntentId, refunded: true });
    expect((await processStripeEvent(t.db, gw, ev)).handled).toBe("refund_recorded");
    expect((await getBooking(t.db, h.bookingId)).status).toBe("REFUNDED");
    expect((await seatsOf(t.db, [w.seatIds[6]]))[0].status).toBe("AVAILABLE");
    // Partial refund (refunded: false) does not cancel anything.
    const { hold: h2, checkout: c2 } = await bookAndPay(t.db, gw, w.alice, w.showtime.id, [w.seatIds[7]]);
    const p2 = await getPayment(t.db, c2.paymentId);
    const partial = verifiedEvent(gw, "charge.refunded", { id: "ch_test_3", object: "charge", payment_intent: p2.providerPaymentIntentId, refunded: false });
    expect((await processStripeEvent(t.db, gw, partial)).handled).toBe("ignored");
    expect((await getBooking(t.db, h2.bookingId)).status).toBe("CONFIRMED");
  });

  it("inside the 2h cutoff: NOT_CANCELLABLE for users, allowed for admins", async () => {
    const gw = new FakeGateway();
    const { hold: h } = await bookAndPay(t.db, gw, w.alice, soon.showtime.id, [soon.seatIds[0]]);
    const e = await caught(() => cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false }));
    expect(e.code).toBe("NOT_CANCELLABLE");
    expect(gw.calls.refund).toHaveLength(0);
    expect((await getBooking(t.db, h.bookingId)).status).toBe("CONFIRMED");
    const r = await cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.admin.id, isAdmin: true });
    expect(r.status).toBe("REFUNDED");
    expect(gw.calls.refund).toHaveLength(1);
  });

  it("cutoff boundary uses the provided clock", async () => {
    const gw = new FakeGateway();
    const { hold: h } = await bookAndPay(t.db, gw, w.alice, w.showtime.id, [w.seatIds[8]]);
    const justInside = new Date(w.showtime.startsAt.getTime() - 119 * MINUTE);
    await expect(
      cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false, now: justInside }),
    ).rejects.toMatchObject({ code: "NOT_CANCELLABLE" });
    const justOutside = new Date(w.showtime.startsAt.getTime() - 121 * MINUTE);
    const r = await cancelBooking(t.db, gw, { bookingId: h.bookingId, actorUserId: w.alice.id, isAdmin: false, now: justOutside });
    expect(r.status).toBe("REFUNDED");
  });
});

describe("authorization", () => {
  let t: TestDb;
  let w: World;
  const gw = new FakeGateway();
  let aliceBooking: string;
  let aliceSession: string;
  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db);
    const h = await hold(t.db, w.alice, w.showtime.id, [w.seatIds[0]]);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    aliceBooking = h.bookingId;
    aliceSession = c.sessionId;
  });
  afterAll(() => t.close());

  it("getBookingDetail returns null for another user's booking; admin can view any", async () => {
    expect(await getBookingDetail(t.db, aliceBooking, { userId: w.bob.id })).toBeNull();
    expect(await getBookingDetail(t.db, aliceBooking, { userId: w.alice.id })).not.toBeNull();
    expect(await getBookingDetail(t.db, aliceBooking, { userId: w.admin.id, admin: true })).not.toBeNull();
    expect(await getBookingDetail(t.db, "00000000-0000-0000-0000-000000000000", { userId: w.alice.id })).toBeNull();
  });

  it("cancelBooking by another user -> NOT_FOUND, booking untouched", async () => {
    const e = await caught(() => cancelBooking(t.db, gw, { bookingId: aliceBooking, actorUserId: w.bob.id, isAdmin: false }));
    expect(e.code).toBe("NOT_FOUND");
    expect((await getBooking(t.db, aliceBooking)).status).toBe("PENDING");
  });

  it("startCheckout for another user's booking -> NOT_FOUND", async () => {
    const e = await caught(() =>
      startCheckout(t.db, gw, { bookingId: aliceBooking, userId: w.bob.id, email: w.bob.email, appUrl: APP_URL }),
    );
    expect(e.code).toBe("NOT_FOUND");
  });

  it("confirmFromRedirect with another user's booking or session -> NOT_FOUND", async () => {
    gw.pay(aliceSession);
    const e1 = await caught(() => confirmFromRedirect(t.db, gw, { bookingId: aliceBooking, userId: w.bob.id, sessionId: aliceSession }));
    expect(e1.code).toBe("NOT_FOUND");
    // Bob's own booking with Alice's session id
    const hb = await hold(t.db, w.bob, w.showtime.id, [w.seatIds[1]]);
    const e2 = await caught(() => confirmFromRedirect(t.db, gw, { bookingId: hb.bookingId, userId: w.bob.id, sessionId: aliceSession }));
    expect(e2.code).toBe("NOT_FOUND");
    const e3 = await caught(() => confirmFromRedirect(t.db, gw, { bookingId: aliceBooking, userId: w.alice.id, sessionId: "cs_test_forged" }));
    expect(e3.code).toBe("NOT_FOUND");
    expect((await getBooking(t.db, aliceBooking)).status).toBe("PENDING");
    // The owner can confirm via the redirect (session re-fetched from the provider).
    const ok = await confirmFromRedirect(t.db, gw, { bookingId: aliceBooking, userId: w.alice.id, sessionId: aliceSession });
    expect(ok.outcome).toBe("confirmed");
  });

  it("admin can cancel any user's booking", async () => {
    const hb = await hold(t.db, w.bob, w.showtime.id, [w.seatIds[2]]);
    const r = await cancelBooking(t.db, gw, { bookingId: hb.bookingId, actorUserId: w.admin.id, isAdmin: true });
    expect(r.status).toBe("CANCELLED");
  });
});

describe("admin", () => {
  let t: TestDb;
  let w: World;
  beforeAll(async () => {
    t = await freshDb();
    w = await buildWorld(t.db);
  });
  afterAll(() => t.close());

  it("createShowtime creates priced showtime_seats", async () => {
    const startsAt = new Date(Date.now() + 10 * 24 * HOUR);
    const st = await createShowtime(t.db, w.admin.id, {
      movieId: w.movie.id,
      auditoriumId: w.auditorium.id,
      startsAt: startsAt.toISOString(),
      basePriceMinor: 1001,
    });
    expect(st.startsAt.getTime()).toBe(startsAt.getTime());
    expect(st.endsAt.getTime()).toBe(startsAt.getTime() + (100 + 15) * MINUTE);
    const ss = await t.db.select().from(s.showtimeSeats).where(eq(s.showtimeSeats.showtimeId, st.id));
    expect(ss).toHaveLength(w.seatRows.length);
    const typeOf = new Map(w.seatRows.map((x) => [x.id, x.seatType]));
    for (const x of ss) {
      expect(x.status).toBe("AVAILABLE");
      expect(x.priceMinor).toBe(seatPrice(1001, typeOf.get(x.seatId)!));
    }
    expect(ss.some((x) => x.priceMinor === 1401)).toBe(true); // premium 1001*1.4 = 1401.4 -> 1401
  });

  it("createShowtime rejects past starts, overlaps, and bad input", async () => {
    const e1 = await caught(() =>
      createShowtime(t.db, w.admin.id, { movieId: w.movie.id, auditoriumId: w.auditorium.id, startsAt: new Date(Date.now() - 1000).toISOString(), basePriceMinor: 1000 }),
    );
    expect(e1.code).toBe("BAD_REQUEST");
    const overlap = new Date(w.showtime.startsAt.getTime() + 30 * MINUTE);
    const e2 = await caught(() =>
      createShowtime(t.db, w.admin.id, { movieId: w.movie.id, auditoriumId: w.auditorium.id, startsAt: overlap.toISOString(), basePriceMinor: 1000 }),
    );
    expect(e2.code).toBe("CONFLICT");
    // Turnaround counts: starting right when the film ends (but before cleaning is done) overlaps.
    const e3 = await caught(() =>
      createShowtime(t.db, w.admin.id, {
        movieId: w.movie.id,
        auditoriumId: w.auditorium.id,
        startsAt: new Date(w.showtime.endsAt.getTime() - 5 * MINUTE).toISOString(),
        basePriceMinor: 1000,
      }),
    );
    expect(e3.code).toBe("CONFLICT");
    const e4 = await caught(() =>
      createShowtime(t.db, w.admin.id, { movieId: w.movie.id, auditoriumId: w.auditorium.id, startsAt: "not a date", basePriceMinor: 1000 }),
    );
    expect(e4.name).toBe("ZodError");
    const e5 = await caught(() =>
      createShowtime(t.db, w.admin.id, { movieId: w.movie.id, auditoriumId: w.auditorium.id, startsAt: new Date(Date.now() + 99 * HOUR).toISOString(), basePriceMinor: -5 }),
    );
    expect(e5.name).toBe("ZodError");
    const e6 = await caught(() =>
      createShowtime(t.db, w.admin.id, {
        movieId: "00000000-0000-0000-0000-000000000000",
        auditoriumId: w.auditorium.id,
        startsAt: new Date(Date.now() + 99 * HOUR).toISOString(),
        basePriceMinor: 5,
      }),
    );
    expect(e6.code).toBe("NOT_FOUND");
  });

  it("cancelShowtime refunds confirmed bookings and releases pending ones", async () => {
    const gw = new FakeGateway();
    const st = await w.addShowtime(new Date(Date.now() + 20 * 24 * HOUR));
    const paid = await bookAndPay(t.db, gw, w.alice, st.showtime.id, [st.seatIds[0], st.seatIds[1]]);
    const pending = await hold(t.db, w.bob, st.showtime.id, [st.seatIds[2]]);
    const r = await cancelShowtime(t.db, gw, w.admin.id, st.showtime.id);
    expect(r).toEqual({ refunded: 1, released: 1, failures: [] });
    expect((await getBooking(t.db, paid.hold.bookingId)).status).toBe("REFUNDED");
    expect((await getBooking(t.db, pending.bookingId)).status).toBe("CANCELLED");
    expect(gw.uniqueRefunds).toBe(1);
    const [row] = await t.db.select().from(s.showtimes).where(eq(s.showtimes.id, st.showtime.id));
    expect(row.status).toBe("CANCELLED");
    // No new holds on a cancelled showtime; cancelling twice -> NOT_FOUND.
    await expect(hold(t.db, w.bob, st.showtime.id, [st.seatIds[5]])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(cancelShowtime(t.db, gw, w.admin.id, st.showtime.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A cancelled showtime frees the slot for a new one.
    const again = await createShowtime(t.db, w.admin.id, {
      movieId: w.movie.id,
      auditoriumId: w.auditorium.id,
      startsAt: st.showtime.startsAt.toISOString(),
      basePriceMinor: 900,
    });
    expect(again.id).toBeTruthy();
    expect(await invariantViolations(t.db)).toEqual([]);
  });

  it("[BUG-5] late payment for an expired booking on a since-cancelled showtime is refunded, not confirmed", async () => {
    const gw = new FakeGateway();
    const st = await w.addShowtime(new Date(Date.now() + 25 * 24 * HOUR));
    const h = await hold(t.db, w.alice, st.showtime.id, [st.seatIds[0]]);
    const c = await checkout(t.db, gw, w.alice, h.bookingId);
    const b0 = await getBooking(t.db, h.bookingId);
    // Hold lapses and is swept, then the admin cancels the (now empty) showtime.
    await releaseExpiredHolds(t.db, new Date(b0.holdExpiresAt.getTime() + 1000));
    expect(await cancelShowtime(t.db, gw, w.admin.id, st.showtime.id)).toEqual({ refunded: 0, released: 0, failures: [] });
    // The customer completes payment on the still-open Stripe page.
    gw.pay(c.sessionId);
    const r = await processStripeEvent(t.db, gw, completedEvent(gw, c.sessionId));
    expect((await getBooking(t.db, h.bookingId)).status).not.toBe("CONFIRMED");
    expect(r.handled).toBe("refund_required");
    expect(gw.uniqueRefunds).toBe(1);
    expect(await ticketsOf(t.db, h.bookingId)).toHaveLength(0);
  });

  it("setSeatBlocked only toggles AVAILABLE <-> BLOCKED", async () => {
    const seat = w.seatIds[10];
    const blocked = await setSeatBlocked(t.db, w.admin.id, seat, true);
    expect(blocked.status).toBe("BLOCKED");
    await expect(setSeatBlocked(t.db, w.admin.id, seat, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(hold(t.db, w.alice, w.showtime.id, [seat])).rejects.toMatchObject({ code: "SEATS_UNAVAILABLE" });
    expect((await setSeatBlocked(t.db, w.admin.id, seat, false)).status).toBe("AVAILABLE");
    await expect(setSeatBlocked(t.db, w.admin.id, seat, false)).rejects.toMatchObject({ code: "CONFLICT" });
    // A held seat cannot be blocked (would strand the customer's hold).
    const h = await hold(t.db, w.alice, w.showtime.id, [w.seatIds[11]]);
    await expect(setSeatBlocked(t.db, w.admin.id, w.seatIds[11], true)).rejects.toMatchObject({ code: "CONFLICT" });
    const [s11] = await seatsOf(t.db, [w.seatIds[11]]);
    expect(s11).toMatchObject({ status: "HELD", heldByBookingId: h.bookingId });
    await expect(setSeatBlocked(t.db, w.admin.id, w.seatIds[11], false)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("createMovie validates input and assigns genres; duplicates -> CONFLICT", async () => {
    await t.db.insert(s.genres).values([{ name: "Drama", slug: "drama" }, { name: "Action", slug: "action" }]);
    const m = await createMovie(t.db, w.admin.id, {
      title: "  Brand New Film ",
      synopsis: "Plot.",
      durationMinutes: "95",
      language: "English",
      ageRating: "PG",
      releaseDate: "2026-11-01",
      posterUrl: "https://example.com/p.jpg",
      genreSlugs: ["drama", "action", "nope"],
    });
    expect(m).toMatchObject({ title: "Brand New Film", slug: "brand-new-film-2026", durationMinutes: 95 });
    const g = await t.db.select().from(s.movieGenres).where(eq(s.movieGenres.movieId, m.id));
    expect(g).toHaveLength(2);
    const dup = await caught(() =>
      createMovie(t.db, w.admin.id, { title: "Brand New Film", synopsis: "x", durationMinutes: 90, language: "English", ageRating: "PG", releaseDate: "2026-05-05" }),
    );
    expect(dup.code).toBe("CONFLICT");
    for (const bad of [
      { title: "", synopsis: "x", durationMinutes: 90, language: "E", ageRating: "PG", releaseDate: "2026-01-01" },
      { title: "X1", synopsis: "x", durationMinutes: 0, language: "E", ageRating: "PG", releaseDate: "2026-01-01" },
      { title: "X2", synopsis: "x", durationMinutes: 601, language: "E", ageRating: "PG", releaseDate: "2026-01-01" },
      { title: "X3", synopsis: "x", durationMinutes: 90, language: "E", ageRating: "PG", releaseDate: "01/01/2026" },
      { title: "X4", synopsis: "x", durationMinutes: 90, language: "E", ageRating: "PG", releaseDate: "2026-01-01", posterUrl: "http://insecure.example/p.jpg" },
      { title: "X5", synopsis: "x", durationMinutes: 90, language: "E", ageRating: "PG", releaseDate: "2026-01-01", posterUrl: "javascript:alert(1)" },
    ]) {
      const e = await caught(() => createMovie(t.db, w.admin.id, bad));
      expect(e.name, JSON.stringify(bad)).toBe("ZodError");
    }
    const upd = await updateMovie(t.db, w.admin.id, m.id, { isActive: false, genreSlugs: ["drama"] });
    expect(upd.isActive).toBe(false);
    expect(await t.db.select().from(s.movieGenres).where(eq(s.movieGenres.movieId, m.id))).toHaveLength(1);
    await expect(updateMovie(t.db, w.admin.id, "00000000-0000-0000-0000-000000000000", { title: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("admin read models and ticket lookup work", async () => {
    const gw = new FakeGateway();
    const { hold: h } = await bookAndPay(t.db, gw, w.alice, w.showtime.id, [w.seatIds[20]]);
    const stats = await adminStats(t.db);
    expect(stats.confirmed30d).toBeGreaterThanOrEqual(1);
    expect(stats.revenue30dMinor).toBeGreaterThanOrEqual(h.totalMinor);
    const list = await adminListBookings(t.db, { status: "CONFIRMED" });
    expect(list.map((b) => b.id)).toContain(h.bookingId);
    expect(list.find((b) => b.id === h.bookingId)!.userEmail).toBe(w.alice.email);
    const [ticket] = await ticketsOf(t.db, h.bookingId);
    expect((await findTicketByCode(t.db, ticket.code))?.bookingId).toBe(h.bookingId);
    expect(await findTicketByCode(t.db, "nope")).toBeNull();
  });

  it("[BUG-1] adminListMovies counts upcoming showtimes (correlated subquery)", async () => {
    const list = await adminListMovies(t.db);
    const row = list.find((m) => m.id === w.movie.id)!;
    expect(row.upcomingShowtimes).toBeGreaterThanOrEqual(1);
  });
});
