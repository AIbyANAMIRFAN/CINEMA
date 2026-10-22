import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import type { CheckoutSessionInfo, CheckoutSessionInput, PaymentGateway } from "@/server/gateway";

export const WEBHOOK_SECRET = "whsec_test_cinebook_qa_secret";
const stripe = new Stripe("sk_test_x");

const rid = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

type StoredSession = CheckoutSessionInfo & { input: CheckoutSessionInput };

/**
 * In-memory PaymentGateway. Records every call; Checkout sessions are idempotent per idempotency key
 * and refunds are idempotent per idempotency key (same key -> same refund id), like Stripe.
 */
export class FakeGateway implements PaymentGateway {
  sessions = new Map<string, StoredSession>();
  private sessionsByKey = new Map<string, string>();
  private refundsByKey = new Map<string, string>();
  calls = {
    create: [] as CheckoutSessionInput[],
    retrieve: [] as string[],
    expire: [] as string[],
    refund: [] as { paymentIntentId: string; amountMinor: number; idempotencyKey: string; reason?: string }[],
  };
  /** Set to make createCheckoutSession throw (provider outage). */
  failCreate = false;

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionInfo> {
    this.calls.create.push(input);
    if (this.failCreate) throw new Error("provider down");
    const existing = this.sessionsByKey.get(input.idempotencyKey);
    if (existing) return this.view(existing);
    const id = rid("cs_test");
    const s: StoredSession = {
      id,
      url: `https://checkout.stripe.test/pay/${id}`,
      status: "open",
      paymentStatus: "unpaid",
      paymentIntentId: null,
      amountTotal: input.amountMinor,
      currency: input.currency.toLowerCase(),
      metadata: { bookingId: input.bookingId, paymentId: input.paymentId, reference: input.reference },
      input,
    };
    this.sessions.set(id, s);
    this.sessionsByKey.set(input.idempotencyKey, id);
    return this.view(id);
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionInfo> {
    this.calls.retrieve.push(sessionId);
    if (!this.sessions.has(sessionId)) throw new Error(`No such checkout.session: ${sessionId}`);
    return this.view(sessionId);
  }

  async expireCheckoutSession(sessionId: string) {
    this.calls.expire.push(sessionId);
    const s = this.sessions.get(sessionId);
    if (s && s.status === "open") s.status = "expired";
  }

  async refund(input: { paymentIntentId: string; amountMinor: number; idempotencyKey: string; reason?: string }) {
    this.calls.refund.push(input);
    let id = this.refundsByKey.get(input.idempotencyKey);
    if (!id) {
      id = rid("re_test");
      this.refundsByKey.set(input.idempotencyKey, id);
    }
    return { id };
  }

  get uniqueRefunds() {
    return this.refundsByKey.size;
  }

  constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
    return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  }

  private view(id: string): CheckoutSessionInfo {
    const { input: _i, ...info } = this.sessions.get(id)!;
    return { ...info, metadata: { ...info.metadata } };
  }

  /** Simulate the customer paying: the session becomes complete/paid. Overrides let tests tamper. */
  pay(sessionId: string, over: { amountTotal?: number; currency?: string; paymentStatus?: CheckoutSessionInfo["paymentStatus"] } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("unknown session");
    s.status = "complete";
    s.paymentStatus = over.paymentStatus ?? "paid";
    s.paymentIntentId ??= rid("pi_test");
    if (over.amountTotal !== undefined) s.amountTotal = over.amountTotal;
    if (over.currency !== undefined) s.currency = over.currency;
    return this.view(sessionId);
  }

  /** Stripe Checkout Session object as it appears in event.data.object. */
  sessionObject(sessionId: string) {
    const s = this.sessions.get(sessionId)!;
    return {
      id: s.id,
      object: "checkout.session",
      url: s.status === "open" ? s.url : null,
      status: s.status,
      payment_status: s.paymentStatus,
      payment_intent: s.paymentIntentId,
      amount_total: s.amountTotal,
      currency: s.currency,
      metadata: s.metadata,
      client_reference_id: s.metadata.bookingId,
      mode: "payment",
    };
  }
}

// ---------------------------------------------------------------------------
// Signed webhook events (real Stripe signature scheme)
// ---------------------------------------------------------------------------

export function signedEvent(type: string, object: Record<string, unknown>, id = rid("evt_test")) {
  const payload = JSON.stringify({
    id,
    object: "event",
    api_version: "2025-01-27.acacia",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { id, payload, header };
}

/** Build, sign and verify an event exactly as the webhook route does, returning the parsed event. */
export function verifiedEvent(gw: FakeGateway, type: string, object: Record<string, unknown>, id?: string) {
  const e = signedEvent(type, object, id);
  return gw.constructWebhookEvent(e.payload, e.header);
}

export function completedEvent(gw: FakeGateway, sessionId: string, id?: string) {
  return verifiedEvent(gw, "checkout.session.completed", gw.sessionObject(sessionId), id);
}
