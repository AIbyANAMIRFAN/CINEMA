import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { startCheckout } from "@/server/checkout";
import { appUrl, db, getGateway } from "@/server/context";
import { requireUser, route } from "@/server/http";

/** Returns a Stripe Checkout URL for a pending booking (reusing an open session on retry). */
export const POST = route("bookings.checkout", async (_req, ctx: RouteContext<"/api/bookings/[id]/checkout">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Booking not found.");
  const result = await startCheckout(db, getGateway(), {
    bookingId: id,
    userId: user.id,
    email: user.email,
    appUrl: appUrl(),
  });
  return NextResponse.json(result);
});
