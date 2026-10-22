import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import * as s from "@/db/schema";
import { holdSeats } from "@/server/bookings";
import { processStripeEvent, startCheckout } from "@/server/checkout";
import { completedEvent, type FakeGateway } from "./fake-gateway";

export const APP_URL = "http://app.test";

let keySeq = 0;
export const key = (p = "k") => `${p}-${process.pid}-${++keySeq}-${Math.random().toString(36).slice(2, 8)}`;

export async function hold(db: Database, user: { id: string }, showtimeId: string, seatIds: string[], now?: Date) {
  return holdSeats(db, { userId: user.id, showtimeId, showtimeSeatIds: seatIds, idempotencyKey: key("hold"), now });
}

export async function checkout(db: Database, gw: FakeGateway, user: { id: string; email: string }, bookingId: string, now?: Date) {
  const r = await startCheckout(db, gw, { bookingId, userId: user.id, email: user.email, appUrl: APP_URL, now });
  const [p] = await db.select().from(s.payments).where(eq(s.payments.id, r.paymentId));
  return { ...r, payment: p, sessionId: p.providerSessionId! };
}

/** Hold -> checkout -> pay -> signed checkout.session.completed webhook. */
export async function bookAndPay(db: Database, gw: FakeGateway, user: { id: string; email: string }, showtimeId: string, seatIds: string[]) {
  const h = await hold(db, user, showtimeId, seatIds);
  const c = await checkout(db, gw, user, h.bookingId);
  gw.pay(c.sessionId);
  const result = await processStripeEvent(db, gw, completedEvent(gw, c.sessionId));
  return { hold: h, checkout: c, result };
}

export async function getBooking(db: Database, id: string) {
  const [b] = await db.select().from(s.bookings).where(eq(s.bookings.id, id));
  return b;
}
export async function getPayment(db: Database, id: string) {
  const [p] = await db.select().from(s.payments).where(eq(s.payments.id, id));
  return p;
}
export async function seatsOf(db: Database, ids: string[]) {
  const rows = await db.select().from(s.showtimeSeats);
  const set = new Set(ids);
  return rows.filter((r) => set.has(r.id));
}
export async function itemsOf(db: Database, bookingId: string) {
  return db.select().from(s.bookingItems).where(eq(s.bookingItems.bookingId, bookingId));
}
export async function ticketsOf(db: Database, bookingId: string) {
  return db.select().from(s.tickets).where(eq(s.tickets.bookingId, bookingId));
}
