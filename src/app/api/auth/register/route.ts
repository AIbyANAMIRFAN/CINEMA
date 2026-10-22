import { NextResponse } from "next/server";
import { db, startSession } from "@/server/context";
import { readJson, route } from "@/server/http";
import { registerUser } from "@/server/users";

export const POST = route("auth.register", async (req) => {
  const user = await registerUser(db, await readJson(req));
  await startSession(user.id);
  return NextResponse.json({ user }, { status: 201 });
});
