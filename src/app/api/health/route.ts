import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/server/context";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: "up" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
