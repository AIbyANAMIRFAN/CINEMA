import { NextResponse } from "next/server";
import { z } from "zod";
import { holdSeats } from "@/server/bookings";
import { listUserBookings } from "@/server/catalog";
import { db } from "@/server/context";
import { readJson, requireUser, route } from "@/server/http";

const holdBody = z.object({
  showtimeId: z.string().uuid(),
  seatIds: z.array(z.string().uuid()).min(1, "Select at least one seat.").max(10, "You can book at most 10 seats."),
  idempotencyKey: z.string().min(8).max(100),
});

export const GET = route("bookings.list", async () => {
  const user = await requireUser();
  return NextResponse.json({ bookings: await listUserBookings(db, user.id) }, { headers: { "Cache-Control": "no-store" } });
});

/** Hold seats and create a PENDING booking. Retrying with the same idempotencyKey is safe. */
export const POST = route("bookings.hold", async (req) => {
  const user = await requireUser();
  const body = holdBody.parse(await readJson(req));
  const result = await holdSeats(db, {
    userId: user.id,
    showtimeId: body.showtimeId,
    showtimeSeatIds: body.seatIds,
    idempotencyKey: body.idempotencyKey,
  });
  return NextResponse.json({ booking: result }, { status: result.replayed ? 200 : 201 });
});
