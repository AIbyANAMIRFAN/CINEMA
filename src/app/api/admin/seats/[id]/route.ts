import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { setSeatBlocked } from "@/server/admin";
import { db } from "@/server/context";
import { readJson, requireAdmin, route } from "@/server/http";

const body = z.object({ blocked: z.boolean() });

/** Block or unblock one showtime seat (id is a showtime_seats id). */
export const PATCH = route("admin.seats.update", async (req, ctx: RouteContext<"/api/admin/seats/[id]">) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Seat not found.");
  const { blocked } = body.parse(await readJson(req));
  const seat = await setSeatBlocked(db, admin.id, id, blocked);
  return NextResponse.json({ seat });
});
