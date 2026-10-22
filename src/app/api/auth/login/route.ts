import { NextResponse } from "next/server";
import { db, startSession } from "@/server/context";
import { readJson, route } from "@/server/http";
import { verifyCredentials } from "@/server/users";

export const POST = route("auth.login", async (req) => {
  const user = await verifyCredentials(db, await readJson(req));
  await startSession(user.id);
  return NextResponse.json({ user });
});
