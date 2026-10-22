import { NextResponse } from "next/server";
import { adminListMovies, createMovie } from "@/server/admin";
import { db } from "@/server/context";
import { readJson, requireAdmin, route } from "@/server/http";

export const GET = route("admin.movies.list", async () => {
  await requireAdmin();
  return NextResponse.json({ movies: await adminListMovies(db) });
});

export const POST = route("admin.movies.create", async (req) => {
  const admin = await requireAdmin();
  const movie = await createMovie(db, admin.id, await readJson(req));
  return NextResponse.json({ movie }, { status: 201 });
});
