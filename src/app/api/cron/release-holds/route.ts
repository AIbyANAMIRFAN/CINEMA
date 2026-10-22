import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { log } from "@/lib/logger";
import { releaseExpiredHolds } from "@/server/bookings";
import { db } from "@/server/context";

function authorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Releases lapsed seat holds. Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
 * Idempotent: running it repeatedly or concurrently is safe.
 */
async function handler(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  try {
    const result = await releaseExpiredHolds(db);
    log.info("cron.release_holds", { ...result, ms: Date.now() - started });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error("cron.release_holds_failed", { error: err });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;
