import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { confirmFromRedirect } from "@/server/checkout";
import { db, getGateway } from "@/server/context";
import { readJson, requireUser, route } from "@/server/http";

const body = z.object({ sessionId: z.string().min(1).max(255) });

/**
 * Called by the success page. Re-fetches the session from Stripe (never trusting the browser)
 * and settles it exactly like the webhook would. Safe to call repeatedly.
 */
export const POST = route("bookings.confirm", async (req, ctx: RouteContext<"/api/bookings/[id]/confirm">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Booking not found.");
  const { sessionId } = body.parse(await readJson(req));
  const outcome = await confirmFromRedirect(db, getGateway(), { bookingId: id, userId: user.id, sessionId });
  return NextResponse.json({ outcome });
});
