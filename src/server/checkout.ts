import { and, desc, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { Database } from "@/db/client";
import { bookings, cinemas, auditoriums, movies, payments, showtimes, webhookEvents } from "@/db/schema";
import { AppError, PG_UNIQUE_VIOLATION, pgCode } from "@/lib/errors";
import { log } from "@/lib/logger";
import { CHECKOUT_HOLD_GRACE_MINUTES, CHECKOUT_SESSION_MINUTES } from "@/lib/pricing";
import {
  audit,
  confirmPaidSession,
  finalizeRefund,
  markPaymentFailedByIntent,
  markSessionExpired,
  refundOrphanPayment,
  releaseBooking,
  type ConfirmOutcome,
} from "./bookings";
import { sessionInfoFromEvent, type CheckoutSessionInfo, type PaymentGateway } from "./gateway";

const minutes = (n: number) => n * 60_000;

/**
 * Create (or reuse) a provider checkout session for a PENDING booking.
 * Retries and double clicks reuse the open session; each new attempt gets its own idempotency key,
 * so the provider can never create two sessions for one attempt.
 */
export async function startCheckout(
  db: Database,
  gateway: PaymentGateway,
  input: { bookingId: string; userId: string; email: string; appUrl: string; now?: Date },
): Promise<{ url: string; paymentId: string; reused: boolean }> {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ booking: bookings, movieTitle: movies.title, startsAt: showtimes.startsAt, cinemaName: cinemas.name })
    .from(bookings)
    .innerJoin(showtimes, eq(showtimes.id, bookings.showtimeId))
    .innerJoin(movies, eq(movies.id, showtimes.movieId))
    .innerJoin(auditoriums, eq(auditoriums.id, showtimes.auditoriumId))
    .innerJoin(cinemas, eq(cinemas.id, auditoriums.cinemaId))
    .where(eq(bookings.id, input.bookingId));
  if (!row || row.booking.userId !== input.userId) throw new AppError("NOT_FOUND", "Booking not found.");
  const { booking } = row;

  // Decide reuse vs. new attempt while holding the booking row lock, so concurrent requests
  // (double clicks, retries) are serialized and can never open two provider sessions.
  type Attempt =
    | { kind: "reuse"; url: string; paymentId: string }
    | { kind: "busy" }
    | { kind: "expired" }
    | { kind: "new"; payment: typeof payments.$inferSelect };
  let attempt: Attempt;
  try {
    attempt = await db.transaction(async (tx): Promise<Attempt> => {
      const [locked] = await tx.select().from(bookings).where(eq(bookings.id, booking.id)).for("update");
      if (locked.status !== "PENDING") {
        throw new AppError("CONFLICT", `This booking is ${locked.status.toLowerCase()} and cannot be paid.`);
      }
      if (locked.holdExpiresAt <= now) {
        await releaseBooking(tx, locked.id, "EXPIRED", now);
        return { kind: "expired" };
      }
      const existing = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.bookingId, locked.id), eq(payments.status, "PENDING")))
        .orderBy(desc(payments.createdAt));
      for (const p of existing) {
        if (!p.providerSessionId) {
          // Another request is creating this session right now; abandon it if it never finished.
          if (now.getTime() - p.createdAt.getTime() < 60_000) return { kind: "busy" };
          await tx
            .update(payments)
            .set({ status: "FAILED", failureReason: "abandoned" })
            .where(eq(payments.id, p.id));
          continue;
        }
        const s = await gateway.retrieveCheckoutSession(p.providerSessionId);
        if (s.status === "open" && s.url) return { kind: "reuse", url: s.url, paymentId: p.id };
        if (s.status === "expired") {
          await tx
            .update(payments)
            .set({ status: "CANCELLED", failureReason: "checkout_expired" })
            .where(eq(payments.id, p.id));
        }
      }
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(payments)
        .where(eq(payments.bookingId, locked.id));
      const [payment] = await tx
        .insert(payments)
        .values({
          bookingId: locked.id,
          amountMinor: locked.totalMinor,
          currency: locked.currency,
          idempotencyKey: `checkout:${locked.id}:${n + 1}`,
          status: "PENDING",
        })
        .returning();
      return { kind: "new", payment };
    });
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) attempt = { kind: "busy" };
    else throw err;
  }
  if (attempt.kind === "expired") {
    throw new AppError("HOLD_EXPIRED", "Your seat hold has expired. Please select seats again.");
  }
  if (attempt.kind === "busy") {
    throw new AppError("CONFLICT", "Checkout is already being prepared. Please try again in a moment.");
  }
  if (attempt.kind === "reuse") return { url: attempt.url, paymentId: attempt.paymentId, reused: true };
  const { payment } = attempt;
  const idempotencyKey = payment.idempotencyKey;

  const expiresAt = new Date(now.getTime() + minutes(CHECKOUT_SESSION_MINUTES) + 30_000);
  let session: CheckoutSessionInfo;
  try {
    session = await gateway.createCheckoutSession({
      bookingId: booking.id,
      paymentId: payment.id,
      reference: booking.reference,
      amountMinor: booking.totalMinor,
      currency: booking.currency,
      description: `${row.movieTitle} · ${row.cinemaName} · ${row.startsAt.toISOString()}`,
      customerEmail: input.email,
      successUrl: `${input.appUrl}/bookings/${booking.id}/confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${input.appUrl}/checkout/${booking.id}?cancelled=1`,
      expiresAt,
      idempotencyKey,
    });
  } catch (err) {
    await db
      .update(payments)
      .set({ status: "FAILED", failureReason: "provider_error" })
      .where(eq(payments.id, payment.id));
    log.error("checkout.create_failed", { bookingId: booking.id, error: err });
    throw new AppError("PAYMENT_ERROR", "The payment provider is unavailable. Please try again.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({ providerSessionId: session.id, checkoutUrl: session.url })
      .where(eq(payments.id, payment.id));
    // Keep the seats held for as long as the customer can still pay.
    const holdUntil = new Date(expiresAt.getTime() + minutes(CHECKOUT_HOLD_GRACE_MINUTES));
    await tx.execute(sql`
      update bookings set hold_expires_at = greatest(hold_expires_at, ${holdUntil}), updated_at = now()
       where id = ${booking.id} and status = 'PENDING'`);
    await tx.execute(sql`
      update showtime_seats set hold_expires_at = greatest(hold_expires_at, ${holdUntil}), updated_at = now()
       where held_by_booking_id = ${booking.id} and status = 'HELD'`);
    await audit(tx, {
      actorUserId: input.userId,
      action: "payment.checkout_started",
      entityType: "payment",
      entityId: payment.id,
      metadata: { sessionId: session.id },
    });
  });

  if (!session.url) throw new AppError("PAYMENT_ERROR", "The payment provider did not return a checkout URL.");
  return { url: session.url, paymentId: payment.id, reused: false };
}

/** Confirm from a provider session (webhook or the success-page redirect). Refunds orphaned payments. */
export async function settleSession(db: Database, gateway: PaymentGateway, session: CheckoutSessionInfo): Promise<ConfirmOutcome> {
  if (session.paymentStatus !== "paid") return { outcome: "ignored", reason: `payment_status_${session.paymentStatus}` };
  const result = await confirmPaidSession(db, {
    sessionId: session.id,
    paymentIntentId: session.paymentIntentId,
    amountMinor: session.amountTotal,
    currency: session.currency,
  });
  if (result.outcome === "refund_required") {
    log.warn("payment.auto_refund", { bookingId: result.bookingId, paymentId: result.paymentId, reason: result.reason });
    await refundOrphanPayment(db, gateway, result.paymentId);
  }
  return result;
}

/**
 * Success-page fallback for when the webhook has not arrived yet. The session is re-fetched from
 * the provider, never trusted from the browser, and must belong to this user's booking.
 */
export async function confirmFromRedirect(
  db: Database,
  gateway: PaymentGateway,
  input: { bookingId: string; userId: string; sessionId: string },
): Promise<ConfirmOutcome> {
  const [row] = await db
    .select({ paymentBookingId: payments.bookingId, userId: bookings.userId })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(eq(payments.providerSessionId, input.sessionId));
  if (!row || row.paymentBookingId !== input.bookingId || row.userId !== input.userId) {
    throw new AppError("NOT_FOUND", "Payment not found.");
  }
  return settleSession(db, gateway, await gateway.retrieveCheckoutSession(input.sessionId));
}

export type WebhookResult ={ duplicate: boolean; type: string; handled: string };

/**
 * Process a verified provider event. Every branch is idempotent, so concurrent or repeated deliveries
 * are safe; the event id is recorded only after successful processing so failures are retried.
 */
export async function processStripeEvent(db: Database, gateway: PaymentGateway, event: Stripe.Event): Promise<WebhookResult> {
  const [seen] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, event.id));
  if (seen) return { duplicate: true, type: event.type, handled: "skipped" };

  let handled = "ignored";
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const r = await settleSession(db, gateway, sessionInfoFromEvent(event.data.object));
      handled = r.outcome;
      break;
    }
    case "checkout.session.async_payment_failed": {
      const s = event.data.object;
      await db
        .update(payments)
        .set({ status: "FAILED", failureReason: "async_payment_failed" })
        .where(and(eq(payments.providerSessionId, s.id), eq(payments.status, "PENDING")));
      handled = "payment_failed";
      break;
    }
    case "checkout.session.expired": {
      await markSessionExpired(db, event.data.object.id);
      handled = "session_expired";
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object;
      await markPaymentFailedByIntent(
        db,
        pi.id,
        pi.metadata?.paymentId,
        pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? "payment_failed",
      );
      handled = "payment_failed";
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (intentId && charge.refunded) {
        const [p] = await db.select().from(payments).where(eq(payments.providerPaymentIntentId, intentId));
        if (p) {
          await finalizeRefund(db, { paymentId: p.id, refundId: null });
          handled = "refund_recorded";
        }
      }
      break;
    }
  }

  await db
    .insert(webhookEvents)
    .values({ id: event.id, provider: "stripe", type: event.type })
    .onConflictDoNothing();
  return { duplicate: false, type: event.type, handled };
}
