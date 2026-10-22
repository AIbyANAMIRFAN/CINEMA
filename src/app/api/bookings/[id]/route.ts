import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { getBookingDetail } from "@/server/catalog";
import { db } from "@/server/context";
import { requireUser, route } from "@/server/http";

export const GET = route("bookings.get", async (_req, ctx: RouteContext<"/api/bookings/[id]">) => {
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Booking not found.");
  const booking = await getBookingDetail(db, id, { userId: user.id, admin: user.role === "ADMIN" });
  if (!booking) throw new AppError("NOT_FOUND", "Booking not found.");
  return NextResponse.json({ booking }, { headers: { "Cache-Control": "no-store" } });
});
