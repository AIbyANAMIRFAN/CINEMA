import { NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { cancelShowtime } from "@/server/admin";
import { db, getGateway } from "@/server/context";
import { readJson, requireAdmin, route } from "@/server/http";

const body = z.object({ status: z.literal("CANCELLED") });

/** Cancel a showtime; every confirmed booking is refunded and pending holds are released. */
export const PATCH = route("admin.showtimes.update", async (req, ctx: RouteContext<"/api/admin/showtimes/[id]">) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Showtime not found.");
  body.parse(await readJson(req));
  const result = await cancelShowtime(db, getGateway(), admin.id, id);
  return NextResponse.json(result);
});
