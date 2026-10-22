import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySession } from "@/lib/session-token";
import { StripeGateway, type PaymentGateway } from "./gateway";
import { getUserById, type PublicUser } from "./users";

export { db };

let stripeGateway: PaymentGateway | undefined;
function resolveGateway(): PaymentGateway {
  if (stripeGateway) return stripeGateway;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    log.error("payments.not_configured", { missing: "STRIPE_SECRET_KEY" });
    throw new AppError("PAYMENT_ERROR", "Online payments are not available right now. Please try again later.");
  }
  if (process.env.VERCEL_ENV !== "production" && !key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    throw new Error("Non-production environments must use a Stripe test-mode key");
  }
  stripeGateway = new StripeGateway(key, process.env.STRIPE_WEBHOOK_SECRET);
  return stripeGateway;
}

/**
 * Stripe is configured on first use, not when the gateway is handed out, so flows that never
 * touch the provider (e.g. releasing an unpaid hold) work even when payments are not configured.
 */
const lazyGateway: PaymentGateway = {
  createCheckoutSession: async (input) => resolveGateway().createCheckoutSession(input),
  retrieveCheckoutSession: async (id) => resolveGateway().retrieveCheckoutSession(id),
  expireCheckoutSession: async (id) => resolveGateway().expireCheckoutSession(id),
  refund: async (input) => resolveGateway().refund(input),
  constructWebhookEvent: (raw, sig) => resolveGateway().constructWebhookEvent(raw, sig),
};

export function getGateway(): PaymentGateway {
  return lazyGateway;
}

/** Public base URL used for payment redirects. */
export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** The signed-in user, re-read from the database on every request (deduplicated per render). */
export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  const store = await cookies();
  const userId = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  return getUserById(db, userId);
});

/** For pages: redirect to login (returning here afterwards) when signed out. */
export async function requireUserPage(returnTo: string) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return user;
}

export async function requireAdminPage(returnTo = "/admin") {
  const user = await requireUserPage(returnTo);
  if (user.role !== "ADMIN") redirect("/?error=forbidden");
  return user;
}

export async function startSession(userId: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, await signSession(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
