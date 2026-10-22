import Stripe from "stripe";

export type CheckoutSessionInput = {
  bookingId: string;
  paymentId: string;
  reference: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  idempotencyKey: string;
};

export type CheckoutSessionInfo = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string | null;
  metadata: Record<string, string>;
};

/** The subset of the payment provider CineBook uses. Tests substitute a fake. */
export interface PaymentGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionInfo>;
  retrieveCheckoutSession(sessionId: string): Promise<CheckoutSessionInfo>;
  expireCheckoutSession(sessionId: string): Promise<void>;
  refund(input: { paymentIntentId: string; amountMinor: number; idempotencyKey: string; reason?: string }): Promise<{ id: string }>;
  constructWebhookEvent(rawBody: string, signature: string): Stripe.Event;
}

function toInfo(s: Stripe.Checkout.Session): CheckoutSessionInfo {
  return {
    id: s.id,
    url: s.url,
    status: (s.status ?? "open") as CheckoutSessionInfo["status"],
    paymentStatus: s.payment_status as CheckoutSessionInfo["paymentStatus"],
    paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null),
    amountTotal: s.amount_total,
    currency: s.currency,
    metadata: (s.metadata ?? {}) as Record<string, string>,
  };
}

export function sessionInfoFromEvent(s: Stripe.Checkout.Session) {
  return toInfo(s);
}

export class StripeGateway implements PaymentGateway {
  private readonly stripe: Stripe;
  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2, appInfo: { name: "CineBook" } });
  }

  async createCheckoutSession(input: CheckoutSessionInput) {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer_email: input.customerEmail,
        client_reference_id: input.bookingId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amountMinor,
              product_data: { name: `CineBook ${input.reference}`, description: input.description },
            },
          },
        ],
        metadata: { bookingId: input.bookingId, paymentId: input.paymentId, reference: input.reference },
        payment_intent_data: {
          metadata: { bookingId: input.bookingId, paymentId: input.paymentId, reference: input.reference },
        },
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return toInfo(session);
  }

  async retrieveCheckoutSession(sessionId: string) {
    return toInfo(await this.stripe.checkout.sessions.retrieve(sessionId));
  }

  async expireCheckoutSession(sessionId: string) {
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
    } catch (err) {
      // Already expired or completed: nothing to do.
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
    }
  }

  async refund(input: { paymentIntentId: string; amountMinor: number; idempotencyKey: string; reason?: string }) {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        amount: input.amountMinor,
        reason: "requested_by_customer",
        metadata: input.reason ? { reason: input.reason } : undefined,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { id: refund.id };
  }

  constructWebhookEvent(rawBody: string, signature: string) {
    if (!this.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }
}
