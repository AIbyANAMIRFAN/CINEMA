import { NextResponse } from "next/server";
import { listMovies } from "@/server/catalog";
import { db } from "@/server/context";
import { route } from "@/server/http";

export const GET = route("movies.list", async (req) => {
  const p = new URL(req.url).searchParams;
  const movies = await listMovies(db, {
    q: p.get("q") ?? undefined,
    genre: p.get("genre") ?? undefined,
    language: p.get("language") ?? undefined,
    cinema: p.get("cinema") ?? undefined,
    date: p.get("date") ?? undefined,
  });
  return NextResponse.json({ movies });
});
