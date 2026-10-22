import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors";
import { UUID_RE } from "@/lib/ids";
import { updateMovie } from "@/server/admin";
import { db } from "@/server/context";
import { readJson, requireAdmin, route } from "@/server/http";

export const PATCH = route("admin.movies.update", async (req, ctx: RouteContext<"/api/admin/movies/[id]">) => {
  const admin = await requireAdmin();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) throw new AppError("NOT_FOUND", "Movie not found.");
  const movie = await updateMovie(db, admin.id, id, await readJson(req));
  return NextResponse.json({ movie });
});
