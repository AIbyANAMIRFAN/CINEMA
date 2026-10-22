import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { getSeatMap, getShowtime } from "@/server/catalog";
import { db, getCurrentUser } from "@/server/context";
import { route } from "@/server/http";

export const GET = route("showtimes.seats", async (_req, ctx: RouteContext<"/api/showtimes/[id]/seats">) => {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Showtime not found.");
  const showtime = await getShowtime(db, id);
  if (!showtime) throw new AppError("NOT_FOUND", "Showtime not found.");
  const user = await getCurrentUser();
  const seats = await getSeatMap(db, id, user?.id);
  return NextResponse.json({ showtime, seats }, { headers: { "Cache-Control": "no-store" } });
});
