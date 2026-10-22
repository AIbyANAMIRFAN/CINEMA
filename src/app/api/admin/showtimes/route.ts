import { NextResponse } from "next/server";
import { adminListShowtimes, createShowtime } from "@/server/admin";
import { db } from "@/server/context";
import { readJson, requireAdmin, route } from "@/server/http";

export const GET = route("admin.showtimes.list", async () => {
  await requireAdmin();
  return NextResponse.json({ showtimes: await adminListShowtimes(db) });
});

export const POST = route("admin.showtimes.create", async (req) => {
  const admin = await requireAdmin();
  const showtime = await createShowtime(db, admin.id, await readJson(req));
  return NextResponse.json({ showtime }, { status: 201 });
});
