import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { processStripeEvent } from "@/server/checkout";
import { db, getGateway } from "@/server/context";

/** Stripe webhook: verifies the signature over the raw body, then processes idempotently. */
export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });
  const raw = await req.text();
  const gateway = getGateway();
  let event;
  try {
    event = gateway.constructWebhookEvent(raw, signature);
  } catch (err) {
    log.warn("webhook.bad_signature", { error: err });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }
  try {
    const result = await processStripeEvent(db, gateway, event);
    log.info("webhook.processed", { eventId: event.id, ...result });
    return NextResponse.json({ received: true, ...result });
  } catch (err) {
    // A non-2xx response makes Stripe retry; processing is idempotent so retries are safe.
    log.error("webhook.failed", { eventId: event.id, type: event.type, error: err });
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
