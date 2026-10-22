import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { getCurrentUser } from "./context";
import type { PublicUser } from "./users";

export type ApiError = { error: { code: string; message: string; details?: unknown }; requestId: string };

/**
 * Wrap a route handler: assigns a request id, logs one structured line per request,
 * and maps AppError / ZodError to JSON error responses without leaking internals.
 */
export function route<C>(name: string, fn: (req: Request, ctx: C, requestId: string) => Promise<Response>) {
  return async (req: Request, ctx: C) => {
    const requestId = req.headers.get("x-vercel-id") ?? randomUUID();
    const started = Date.now();
    try {
      assertSameOrigin(req);
      const res = await fn(req, ctx, requestId);
      log.info("api.request", { route: name, method: req.method, status: res.status, ms: Date.now() - started, requestId });
      return res;
    } catch (err) {
      if (err instanceof AppError) {
        log.info("api.request", { route: name, method: req.method, status: err.status, code: err.code, ms: Date.now() - started, requestId });
        return NextResponse.json<ApiError>(
          { error: { code: err.code, message: err.message, details: err.details }, requestId },
          { status: err.status },
        );
      }
      if (err instanceof ZodError) {
        return NextResponse.json<ApiError>(
          {
            error: { code: "BAD_REQUEST", message: err.issues[0]?.message ?? "Invalid request.", details: err.issues },
            requestId,
          },
          { status: 400 },
        );
      }
      log.error("api.unhandled", { route: name, method: req.method, ms: Date.now() - started, requestId, error: err });
      return NextResponse.json<ApiError>(
        { error: { code: "INTERNAL", message: "Something went wrong. Please try again." }, requestId },
        { status: 500 },
      );
    }
  };
}

/** Browsers always send Origin on cross-site POSTs; reject state changes from other sites (CSRF). */
function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  if (!origin) return; // server-to-server callers (webhooks, cron) authenticate separately
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("FORBIDDEN", "Invalid origin.");
  }
  if (originHost !== host) throw new AppError("FORBIDDEN", "Cross-site requests are not allowed.");
}

export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Please sign in to continue.");
  return user;
}

export async function requireAdmin(): Promise<PublicUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new AppError("FORBIDDEN", "Administrator access required.");
  return user;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be valid JSON.");
  }
}
