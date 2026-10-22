import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { findTicketByCode, getBookingDetail } from "@/server/catalog";
import { db } from "@/server/context";
import { requireAdmin, route } from "@/server/http";

/** Door check: validate a scanned ticket code. */
export const GET = route("admin.tickets.verify", async (_req, ctx: RouteContext<"/api/admin/tickets/[code]">) => {
  const admin = await requireAdmin();
  const { code } = await ctx.params;
  const ticket = await findTicketByCode(db, code);
  if (!ticket) throw new AppError("NOT_FOUND", "Ticket not found.");
  const booking = await getBookingDetail(db, ticket.bookingId, { userId: admin.id, admin: true });
  const valid = !ticket.revokedAt && booking?.status === "CONFIRMED";
  return NextResponse.json({ valid, ticket, booking });
});
