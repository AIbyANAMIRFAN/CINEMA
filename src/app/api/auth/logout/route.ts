import { NextResponse } from "next/server";
import { endSession } from "@/server/context";
import { route } from "@/server/http";

export const POST = route("auth.logout", async () => {
  await endSession();
  return NextResponse.json({ ok: true });
});
