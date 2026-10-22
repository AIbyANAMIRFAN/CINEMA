import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession, verifySession } from "@/lib/session-token";
import { StripeGateway, type PaymentGateway } from "./gateway";
import { getUserById, type PublicUser } from "./users";

export { db };

let gateway: PaymentGateway | undefined;
export function getGateway(): PaymentGateway {
  if (gateway) return gateway;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  if (process.env.VERCEL_ENV !== "production" && !key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    throw new Error("Non-production environments must use a Stripe test-mode key");
  }
  gateway = new StripeGateway(key, process.env.STRIPE_WEBHOOK_SECRET);
  return gateway;
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
