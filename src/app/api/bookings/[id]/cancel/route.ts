import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { cancelBooking } from "@/server/bookings";
import { db, getGateway } from "@/server/context";
import { requireUser, route } from "@/server/http";

export const POST = route("bookings.cancel", async (_req, ctx: RouteContext<"/api/bookings/[id]/cancel">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Booking not found.");
  const result = await cancelBooking(db, getGateway(), {
    bookingId: id,
    actorUserId: user.id,
    isAdmin: user.role === "ADMIN",
  });
  return NextResponse.json(result);
});
