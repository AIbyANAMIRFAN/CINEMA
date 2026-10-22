"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/ui/api";
import { Alert, Spinner } from "./ui";

type Outcome =
  | { outcome: "confirmed" | "already_confirmed"; bookingId: string }
  | { outcome: "refund_required"; bookingId: string; reason: string }
  | { outcome: "ignored"; reason: string };

type View =
  | { kind: "working"; message: string }
  | { kind: "confirmed" }
  | { kind: "refunded" }
  | { kind: "closed"; status: string }
  | { kind: "pending" }
  | { kind: "error"; message: string };

const POLL_ATTEMPTS = 8;
const POLL_INTERVAL_MS = 2000;

export function ConfirmFlow({
  bookingId,
  showtimeId,
  sessionId,
  initialStatus,
}: {
  bookingId: string;
  showtimeId: string;
  sessionId: string | null;
  initialStatus: string;
}) {
  const [view, setView] = useState<View>(
    initialStatus === "CONFIRMED" ? { kind: "confirmed" } : { kind: "working", message: "Confirming your payment…" },
  );

  const statusToView = useCallback((status: string): View | null => {
    if (status === "CONFIRMED") return { kind: "confirmed" };
    if (status === "PENDING") return null;
    return { kind: "closed", status };
  }, []);

  const poll = useCallback(async () => {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const res = await api<{ booking: { status: string } }>(`/api/bookings/${bookingId}`);
      if (res.ok) {
        const v = statusToView(res.data.booking.status);
        if (v) return v;
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { kind: "pending" } as View;
  }, [bookingId, statusToView]);

  const run = useCallback(async () => {
    setView({ kind: "working", message: "Confirming your payment…" });
    if (sessionId) {
      const res = await api<{ outcome: Outcome }>(`/api/bookings/${bookingId}/confirm`, { body: { sessionId } });
      if (!res.ok) {
        setView({
          kind: "error",
          message:
            res.status >= 500
              ? "We couldn't verify your payment with the provider just now. If you were charged, your booking will be confirmed automatically — check again in a moment."
              : res.message,
        });
        return;
      }
      const o = res.data.outcome;
      if (o.outcome === "confirmed" || o.outcome === "already_confirmed") {
        setView({ kind: "confirmed" });
        return;
      }
      if (o.outcome === "refund_required") {
        setView({ kind: "refunded" });
        return;
      }
    }
    setView({ kind: "working", message: "Waiting for payment confirmation…" });
    setView(await poll());
  }, [bookingId, poll, sessionId]);

  // Confirming is idempotent on the server, so re-running after a remount is safe.
  useEffect(() => {
    if (initialStatus === "CONFIRMED") return;
    const t = setTimeout(() => void run(), 0);
    return () => clearTimeout(t);
  }, [initialStatus, run]);

  switch (view.kind) {
    case "working":
      return (
        <div className="card flex items-center gap-3 p-6" role="status">
          <Spinner className="text-accent" />
          <span>{view.message}</span>
        </div>
      );
    case "confirmed":
      return (
        <div className="card flex flex-col items-center gap-4 p-8 text-center">
          <div aria-hidden className="grid h-14 w-14 place-items-center rounded-full bg-success/15 text-3xl text-success">
            ✓
          </div>
          <h2 className="text-2xl font-bold">You&apos;re all set!</h2>
          <p className="text-muted">Your payment was received and your seats are booked. Enjoy the show.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href={`/bookings/${bookingId}`} className="btn-primary">
              View ticket
            </Link>
            <Link href="/bookings" className="btn-secondary">
              My bookings
            </Link>
          </div>
        </div>
      );
    case "refunded":
      return (
        <div className="card flex flex-col gap-4 p-6">
          <Alert tone="warning">
            Your payment went through, but your seats were released before it completed, so we couldn&apos;t confirm
            the booking. Your payment has been refunded in full.
          </Alert>
          <Link href={`/showtimes/${showtimeId}`} className="btn-primary">
            Choose new seats
          </Link>
        </div>
      );
    case "closed":
      return (
        <div className="card flex flex-col gap-4 p-6">
          <Alert tone="warning">
            This booking is {view.status.toLowerCase()} and can&apos;t be confirmed. If you were charged, the payment
            will be refunded automatically.
          </Alert>
          <Link href={`/showtimes/${showtimeId}`} className="btn-primary">
            Choose seats again
          </Link>
        </div>
      );
    case "pending":
      return (
        <div className="card flex flex-col gap-4 p-6">
          <Alert tone="info">
            We haven&apos;t received confirmation of your payment yet. This can take a minute — your booking will update
            automatically once the payment is confirmed.
          </Alert>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => void run()} className="btn-primary">
              Check again
            </button>
            <Link href={`/checkout/${bookingId}`} className="btn-secondary">
              Back to checkout
            </Link>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="card flex flex-col gap-4 p-6">
          <Alert tone="error">{view.message}</Alert>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={() => void run()} className="btn-primary">
              Try again
            </button>
            <Link href={`/bookings/${bookingId}`} className="btn-secondary">
              View booking
            </Link>
          </div>
        </div>
      );
  }
}
