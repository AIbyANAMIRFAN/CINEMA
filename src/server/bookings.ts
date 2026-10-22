import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database, DbOrTx, Tx } from "@/db/client";
import {
  auditLogs,
  bookingItems,
  bookings,
  payments,
  showtimeSeats,
  showtimes,
  tickets,
} from "@/db/schema";
import { AppError, PG_DEADLOCK, PG_SERIALIZATION, PG_UNIQUE_VIOLATION, pgCode, pgConstraint } from "@/lib/errors";
import { bookingReference, ticketCode } from "@/lib/ids";
import { log } from "@/lib/logger";
import {
  CANCELLATION_CUTOFF_MINUTES,
  HOLD_MINUTES,
  MAX_SEATS_PER_BOOKING,
  calculateTotals,
} from "@/lib/pricing";
import type { PaymentGateway } from "./gateway";

const minutes = (n: number) => n * 60_000;

export async function audit(
  tx: DbOrTx,
  entry: { actorUserId?: string | null; action: string; entityType: string; entityId?: string | null; metadata?: Record<string, unknown> },
) {
  await tx.insert(auditLogs).values({
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
  });
}

// ---------------------------------------------------------------------------
// Hold seats
// ---------------------------------------------------------------------------

export type HoldInput = {
  userId: string;
  showtimeId: string;
  showtimeSeatIds: string[];
  idempotencyKey: string;
  now?: Date;
};

export type HoldResult = {
  bookingId: string;
  reference: string;
  status: string;
  holdExpiresAt: Date;
  subtotalMinor: number;
  feeMinor: number;
  taxMinor: number;
  totalMinor: number;
  currency: string;
  replayed: boolean;
};

/**
 * Atomically hold seats and create a PENDING booking.
 *
 * 1. begin transaction  2. lock the requested showtime_seats rows (FOR UPDATE, id order)
 * 3. verify each is available (expired holds are released first)  4. mark HELD with expiry
 * 5. price on the server  6. insert booking + items  7. commit.
 * The partial unique index booking_items_active_seat_uq is the last line of defence.
 */
export async function holdSeats(db: Database, input: HoldInput): Promise<HoldResult> {
  const now = input.now ?? new Date();
  const seatIds = [...new Set(input.showtimeSeatIds)].sort();
  if (seatIds.length === 0) throw new AppError("BAD_REQUEST", "Select at least one seat.");
  if (seatIds.length > MAX_SEATS_PER_BOOKING) {
    throw new AppError("BAD_REQUEST", `You can book at most ${MAX_SEATS_PER_BOOKING} seats at once.`);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const replay = await findReplay(tx, input.userId, input.idempotencyKey, seatIds);
        if (replay) return replay;

        const [showtime] = await tx
          .select()
          .from(showtimes)
          .where(eq(showtimes.id, input.showtimeId))
          .for("share");
        if (!showtime) throw new AppError("NOT_FOUND", "Showtime not found.");
        if (showtime.status !== "SCHEDULED") throw new AppError("CONFLICT", "This showtime has been cancelled.");
        if (showtime.startsAt <= now) throw new AppError("CONFLICT", "This showtime has already started.");

        const locked = await lockSeats(tx, input.showtimeId, seatIds);
        if (locked.length !== seatIds.length) {
          throw new AppError("BAD_REQUEST", "One or more seats do not belong to this showtime.");
        }
        // A concurrent request with the same key may have committed while we waited for the locks.
        const lateReplay = await findReplay(tx, input.userId, input.idempotencyKey, seatIds);
        if (lateReplay) return lateReplay;

        // Release any lapsed holds on these seats so they can be re-sold.
        const lapsed = new Set(
          locked
            .filter((s) => s.status === "HELD" && s.holdExpiresAt && s.holdExpiresAt <= now && s.heldByBookingId)
            .map((s) => s.heldByBookingId!),
        );
        for (const bookingId of lapsed) await releaseBooking(tx, bookingId, "EXPIRED", now);
        const current = lapsed.size ? await lockSeats(tx, input.showtimeId, seatIds) : locked;

        const unavailable = current.filter((s) => s.status !== "AVAILABLE");
        if (unavailable.length) {
          throw new AppError("SEATS_UNAVAILABLE", "Some selected seats are no longer available.", {
            seatIds: unavailable.map((s) => s.id),
          });
        }

        const totals = calculateTotals(current.map((s) => s.priceMinor));
        const holdExpiresAt = new Date(now.getTime() + minutes(HOLD_MINUTES));
        const [booking] = await tx
          .insert(bookings)
          .values({
            reference: bookingReference(),
            userId: input.userId,
            showtimeId: input.showtimeId,
            status: "PENDING",
            ...totals,
            currency: showtime.currency,
            idempotencyKey: input.idempotencyKey,
            holdExpiresAt,
          })
          .returning();

        await tx.insert(bookingItems).values(
          current.map((s) => ({ bookingId: booking.id, showtimeSeatId: s.id, priceMinor: s.priceMinor })),
        );
        await tx
          .update(showtimeSeats)
          .set({ status: "HELD", heldByBookingId: booking.id, holdExpiresAt })
          .where(inArray(showtimeSeats.id, seatIds));
        await audit(tx, {
          actorUserId: input.userId,
          action: "booking.held",
          entityType: "booking",
          entityId: booking.id,
          metadata: { seats: seatIds.length, totalMinor: totals.totalMinor },
        });

        return toHoldResult(booking, false);
      });
    } catch (err) {
      const code = pgCode(err);
      if (code === PG_UNIQUE_VIOLATION && pgConstraint(err) === "bookings_user_idempotency_uq") {
        // A concurrent retry with the same key won; return its booking.
        const replay = await findReplay(db, input.userId, input.idempotencyKey, seatIds);
        if (replay) return replay;
      }
      if (code === PG_UNIQUE_VIOLATION && pgConstraint(err) === "booking_items_active_seat_uq") {
        throw new AppError("SEATS_UNAVAILABLE", "Some selected seats are no longer available.");
      }
      if ((code === PG_DEADLOCK || code === PG_SERIALIZATION) && attempt < 2) continue;
      throw err;
    }
  }
}

async function lockSeats(tx: Tx, showtimeId: string, seatIds: string[]) {
  return tx
    .select()
    .from(showtimeSeats)
    .where(and(eq(showtimeSeats.showtimeId, showtimeId), inArray(showtimeSeats.id, seatIds)))
    .orderBy(asc(showtimeSeats.id))
    .for("update");
}

async function findReplay(tx: DbOrTx, userId: string, key: string, seatIds: string[]) {
  const [existing] = await tx
    .select()
    .from(bookings)
    .where(and(eq(bookings.userId, userId), eq(bookings.idempotencyKey, key)));
  if (!existing) return null;
  const items = await tx
    .select({ id: bookingItems.showtimeSeatId })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, existing.id));
  const same = items.length === seatIds.length && items.map((i) => i.id).sort().every((id, i) => id === seatIds[i]);
  if (!same) throw new AppError("CONFLICT", "This request key was already used for a different seat selection.");
  return toHoldResult(existing, true);
}

function toHoldResult(b: typeof bookings.$inferSelect, replayed: boolean): HoldResult {
  return {
    bookingId: b.id,
    reference: b.reference,
    status: b.status,
    holdExpiresAt: b.holdExpiresAt,
    subtotalMinor: b.subtotalMinor,
    feeMinor: b.feeMinor,
    taxMinor: b.taxMinor,
    totalMinor: b.totalMinor,
    currency: b.currency,
    replayed,
  };
}

// ---------------------------------------------------------------------------
// Release (expiry / user cancel of an unpaid booking)
// ---------------------------------------------------------------------------

/**
 * Move a PENDING booking to EXPIRED or CANCELLED and free its seats.
 * Returns false (and changes nothing) if the booking is no longer PENDING, so repeated calls are safe.
 */
export async function releaseBooking(tx: Tx, bookingId: string, to: "EXPIRED" | "CANCELLED", now = new Date()) {
  const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
  if (!b || b.status !== "PENDING") return false;
  await tx
    .update(bookings)
    .set({ status: to, cancelledAt: now })
    .where(eq(bookings.id, bookingId));
  await tx.update(bookingItems).set({ active: false }).where(eq(bookingItems.bookingId, bookingId));
  await tx
    .update(showtimeSeats)
    .set({ status: "AVAILABLE", heldByBookingId: null, holdExpiresAt: null })
    .where(and(eq(showtimeSeats.heldByBookingId, bookingId), eq(showtimeSeats.status, "HELD")));
  await tx
    .update(payments)
    .set({ status: "CANCELLED", failureReason: to === "EXPIRED" ? "hold_expired" : "cancelled_by_user" })
    .where(and(eq(payments.bookingId, bookingId), inArray(payments.status, ["PENDING", "FAILED"])));
  await audit(tx, { action: `booking.${to.toLowerCase()}`, entityType: "booking", entityId: bookingId });
  return true;
}

/**
 * Release every PENDING booking whose hold has lapsed. Idempotent and safe to run concurrently:
 * rows are claimed with SKIP LOCKED and re-checked under lock.
 */
export async function releaseExpiredHolds(db: Database, now = new Date(), batchSize = 100, maxBatches = 20) {
  let released = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await db.transaction(async (tx) => {
      const due = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.status, "PENDING"), lte(bookings.holdExpiresAt, now)))
        .orderBy(asc(bookings.holdExpiresAt))
        .limit(batchSize)
        .for("update", { skipLocked: true });
      let count = 0;
      for (const { id } of due) if (await releaseBooking(tx, id, "EXPIRED", now)) count++;
      return { count, scanned: due.length };
    });
    released += n.count;
    if (n.scanned < batchSize) break;
  }
  // Defensive sweep: HELD seats whose booking is gone or no longer pending (should be none).
  const orphaned = await db.execute(sql`
    update showtime_seats ss
       set status = 'AVAILABLE', held_by_booking_id = null, hold_expires_at = null, updated_at = now()
     where ss.status = 'HELD' and ss.hold_expires_at <= ${now}
       and not exists (select 1 from bookings b where b.id = ss.held_by_booking_id and b.status = 'PENDING')`);
  return { released, orphanedSeatsFreed: orphaned.rowCount ?? 0 };
}

// ---------------------------------------------------------------------------
// Payment confirmation
// ---------------------------------------------------------------------------

export type ConfirmInput = {
  sessionId: string;
  paymentIntentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  now?: Date;
};

export type ConfirmOutcome =
  | { outcome: "confirmed"; bookingId: string }
  | { outcome: "already_confirmed"; bookingId: string }
  | { outcome: "refund_required"; bookingId: string; paymentId: string; reason: string }
  | { outcome: "ignored"; reason: string };

/**
 * Confirm a booking after the provider reports a verified, paid checkout session.
 * Idempotent: replaying the same session returns already_confirmed.
 * If the seats were lost (hold lapsed and resold) or the booking was cancelled, returns refund_required.
 */
export async function confirmPaidSession(db: Database, input: ConfirmInput): Promise<ConfirmOutcome> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.providerSessionId, input.sessionId))
      .for("update");
    if (!payment) return { outcome: "ignored", reason: "unknown_session" };

    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, payment.bookingId)).for("update");
    if (!booking) return { outcome: "ignored", reason: "unknown_booking" };

    if (payment.status === "SUCCEEDED" && booking.status === "CONFIRMED") {
      return { outcome: "already_confirmed", bookingId: booking.id };
    }
    if (payment.status === "REFUNDED") return { outcome: "ignored", reason: "already_refunded" };

    await tx
      .update(payments)
      .set({ providerPaymentIntentId: input.paymentIntentId ?? payment.providerPaymentIntentId })
      .where(eq(payments.id, payment.id));

    // Money was taken but no seats can be given: free any hold, then flag this payment for refund.
    // It stays PENDING (refund pending) until refundOrphanPayment records the provider refund.
    const needRefund = async (reason: string): Promise<ConfirmOutcome> => {
      await releaseBooking(tx, booking.id, "EXPIRED", now);
      await tx
        .update(payments)
        .set({ status: "PENDING", failureReason: `refund_required:${reason}` })
        .where(eq(payments.id, payment.id));
      await audit(tx, { action: "payment.refund_required", entityType: "payment", entityId: payment.id, metadata: { reason } });
      return { outcome: "refund_required", bookingId: booking.id, paymentId: payment.id, reason };
    };

    if (input.amountMinor !== booking.totalMinor || input.currency?.toUpperCase() !== booking.currency) {
      log.error("payment.amount_mismatch", { bookingId: booking.id, expected: booking.totalMinor, got: input.amountMinor });
      return needRefund("amount_mismatch");
    }
    if (booking.status === "CONFIRMED") return needRefund("duplicate_payment");
    const [show] = await tx
      .select({ status: showtimes.status })
      .from(showtimes)
      .where(eq(showtimes.id, booking.showtimeId))
      .for("share");
    if (show?.status !== "SCHEDULED") return needRefund("showtime_cancelled");
    if (booking.status === "CANCELLED" || booking.status === "REFUNDED") return needRefund(`booking_${booking.status.toLowerCase()}`);

    // PENDING, or EXPIRED but the seats may still be free: try to (re)claim every seat.
    const items = await tx.select().from(bookingItems).where(eq(bookingItems.bookingId, booking.id));
    const seatRows = await tx
      .select()
      .from(showtimeSeats)
      .where(inArray(showtimeSeats.id, items.map((i) => i.showtimeSeatId)))
      .orderBy(asc(showtimeSeats.id))
      .for("update");
    const claimable = seatRows.every(
      (s) =>
        s.status === "AVAILABLE" ||
        ((s.status === "HELD" || s.status === "BOOKED") && s.heldByBookingId === booking.id),
    );
    if (!claimable || seatRows.length !== items.length) return needRefund("seats_unavailable");

    await tx
      .update(showtimeSeats)
      .set({ status: "BOOKED", heldByBookingId: booking.id, holdExpiresAt: null })
      .where(inArray(showtimeSeats.id, seatRows.map((s) => s.id)));
    await tx.update(bookingItems).set({ active: true }).where(eq(bookingItems.bookingId, booking.id));
    await tx
      .update(bookings)
      .set({ status: "CONFIRMED", confirmedAt: now, cancelledAt: null })
      .where(eq(bookings.id, booking.id));
    await tx
      .update(payments)
      .set({ status: "SUCCEEDED", failureReason: null })
      .where(eq(payments.id, payment.id));
    await tx
      .update(payments)
      .set({ status: "CANCELLED", failureReason: "superseded" })
      .where(and(eq(payments.bookingId, booking.id), eq(payments.status, "PENDING")));
    await tx.insert(tickets).values({ bookingId: booking.id, code: ticketCode() }).onConflictDoNothing();
    await audit(tx, {
      action: "booking.confirmed",
      entityType: "booking",
      entityId: booking.id,
      metadata: { paymentId: payment.id, recovered: booking.status === "EXPIRED" },
    });
    return { outcome: "confirmed", bookingId: booking.id };
  });
}

/** Issue the provider refund for a payment flagged refund_required, then record it. Idempotent. */
export async function refundOrphanPayment(db: Database, gateway: PaymentGateway, paymentId: string) {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId));
  if (!p || p.status === "REFUNDED" || !p.providerPaymentIntentId) return;
  const refund = await gateway.refund({
    paymentIntentId: p.providerPaymentIntentId,
    amountMinor: p.amountMinor,
    idempotencyKey: `refund:${p.id}`,
    reason: p.failureReason ?? "orphan",
  });
  await db
    .update(payments)
    .set({ status: "REFUNDED", providerRefundId: refund.id })
    .where(eq(payments.id, p.id));
  await audit(db, { action: "payment.refunded", entityType: "payment", entityId: p.id, metadata: { refundId: refund.id } });
}

export async function markPaymentFailed(db: Database, sessionId: string, reason: string) {
  await db
    .update(payments)
    .set({ status: "FAILED", failureReason: reason })
    .where(and(eq(payments.providerSessionId, sessionId), eq(payments.status, "PENDING")));
}

export async function markPaymentFailedByIntent(db: Database, paymentIntentId: string, bookingPaymentId: string | undefined, reason: string) {
  const cond = bookingPaymentId
    ? eq(payments.id, bookingPaymentId)
    : eq(payments.providerPaymentIntentId, paymentIntentId);
  await db
    .update(payments)
    .set({ status: "FAILED", failureReason: reason, providerPaymentIntentId: paymentIntentId })
    .where(and(cond, eq(payments.status, "PENDING")));
}

export async function markSessionExpired(db: Database, sessionId: string) {
  await db
    .update(payments)
    .set({ status: "CANCELLED", failureReason: "checkout_expired" })
    .where(and(eq(payments.providerSessionId, sessionId), inArray(payments.status, ["PENDING", "FAILED"])));
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export type CancelResult = { status: "CANCELLED" | "REFUNDED"; refundedMinor: number };

/**
 * Cancel a booking. PENDING bookings release their hold. CONFIRMED bookings are refunded in full
 * if the show starts more than CANCELLATION_CUTOFF_MINUTES from now (admins bypass the cutoff).
 */
export async function cancelBooking(
  db: Database,
  gateway: PaymentGateway,
  input: { bookingId: string; actorUserId: string; isAdmin: boolean; now?: Date; reason?: string },
): Promise<CancelResult> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ booking: bookings, startsAt: showtimes.startsAt })
    .from(bookings)
    .innerJoin(showtimes, eq(showtimes.id, bookings.showtimeId))
    .where(eq(bookings.id, input.bookingId));
  if (!row || (!input.isAdmin && row.booking.userId !== input.actorUserId)) {
    throw new AppError("NOT_FOUND", "Booking not found.");
  }
  const { booking } = row;

  if (booking.status === "PENDING") {
    const sessions = await db
      .select({ sessionId: payments.providerSessionId })
      .from(payments)
      .where(and(eq(payments.bookingId, booking.id), eq(payments.status, "PENDING")));
    const ok = await db.transaction((tx) => releaseBooking(tx, booking.id, "CANCELLED", now));
    if (!ok) throw new AppError("NOT_CANCELLABLE", "This booking can no longer be cancelled.");
    for (const s of sessions) if (s.sessionId) await gateway.expireCheckoutSession(s.sessionId).catch(() => {});
    return { status: "CANCELLED", refundedMinor: 0 };
  }

  if (booking.status !== "CONFIRMED") {
    throw new AppError("NOT_CANCELLABLE", `A ${booking.status.toLowerCase()} booking cannot be cancelled.`);
  }
  if (!input.isAdmin && row.startsAt.getTime() - now.getTime() < minutes(CANCELLATION_CUTOFF_MINUTES)) {
    throw new AppError(
      "NOT_CANCELLABLE",
      `Bookings can be cancelled up to ${CANCELLATION_CUTOFF_MINUTES / 60} hours before the show.`,
    );
  }

  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, booking.id), eq(payments.status, "SUCCEEDED")));
  if (!payment?.providerPaymentIntentId) {
    throw new AppError("INTERNAL", "No captured payment found for this booking.");
  }

  // Refund first with a stable idempotency key: a retry after a later failure never double-refunds.
  const refund = await gateway.refund({
    paymentIntentId: payment.providerPaymentIntentId,
    amountMinor: payment.amountMinor,
    idempotencyKey: `refund:${payment.id}`,
    reason: input.reason ?? "customer_cancellation",
  });
  await finalizeRefund(db, { paymentId: payment.id, refundId: refund.id, actorUserId: input.actorUserId, now });
  return { status: "REFUNDED", refundedMinor: payment.amountMinor };
}

/** Record a completed full refund: booking REFUNDED, seats released, ticket revoked. Idempotent. */
export async function finalizeRefund(
  db: Database,
  input: { paymentId: string; refundId: string | null; actorUserId?: string | null; now?: Date },
) {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).for("update");
    if (!payment) return;
    const [booking] = await tx.select().from(bookings).where(eq(bookings.id, payment.bookingId)).for("update");
    if (payment.status !== "REFUNDED") {
      await tx
        .update(payments)
        .set({ status: "REFUNDED", providerRefundId: input.refundId ?? payment.providerRefundId })
        .where(eq(payments.id, payment.id));
    }
    if (booking?.status === "CONFIRMED") {
      await tx.update(bookings).set({ status: "REFUNDED", cancelledAt: now }).where(eq(bookings.id, booking.id));
      await tx.update(bookingItems).set({ active: false }).where(eq(bookingItems.bookingId, booking.id));
      await tx
        .update(showtimeSeats)
        .set({ status: "AVAILABLE", heldByBookingId: null, holdExpiresAt: null })
        .where(and(eq(showtimeSeats.heldByBookingId, booking.id), eq(showtimeSeats.status, "BOOKED")));
      await tx.update(tickets).set({ revokedAt: now }).where(eq(tickets.bookingId, booking.id));
      await audit(tx, {
        actorUserId: input.actorUserId,
        action: "booking.refunded",
        entityType: "booking",
        entityId: booking.id,
        metadata: { paymentId: payment.id, refundId: input.refundId },
      });
    }
  });
}
