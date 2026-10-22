import { NextResponse } from "next/server";
import { getCurrentUser } from "@/server/context";
import { route } from "@/server/http";

export const GET = route("auth.me", async () => {
  return NextResponse.json({ user: await getCurrentUser() }, { headers: { "Cache-Control": "no-store" } });
});
