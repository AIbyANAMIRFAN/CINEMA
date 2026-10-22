"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/ui/api";
import { Alert, Spinner } from "./ui";

function paymentErrorMessage(status: number, code: string, message: string) {
  if (code === "NETWORK") return message;
  if (code === "PAYMENT_ERROR" || status === 502) {
    return "The payment provider is unavailable right now. Your seats are still held — please try again in a moment.";
  }
  if (status >= 500) {
    return "We couldn't start the payment. Online payments may be temporarily unavailable; your seats are still held, so please try again shortly.";
  }
  return message;
}

export function CheckoutPanel({
  bookingId,
  showtimeId,
  holdExpiresAt,
  serverNow,
  totalLabel,
  holdUntil,
}: {
  bookingId: string;
  showtimeId: string;
  holdExpiresAt: string;
  serverNow: number;
  totalLabel: string;
  holdUntil: string;
}) {
  const router = useRouter();
  const expiresMs = new Date(holdExpiresAt).getTime();
  const [now, setNow] = useState(serverNow);
  const [busy, setBusy] = useState<"pay" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiredByServer, setExpiredByServer] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = Math.max(0, expiresMs - now);
  const expired = remaining <= 0 || expiredByServer;
  const mm = Math.floor(remaining / 60_000);
  const ss = Math.floor((remaining % 60_000) / 1000)
    .toString()
    .padStart(2, "0");

  async function pay() {
    setBusy("pay");
    setError(null);
    const res = await api<{ url: string }>(`/api/bookings/${bookingId}/checkout`, { method: "POST", body: {} });
    if (res.ok && res.data.url) {
      window.location.assign(res.data.url);
      return;
    }
    setBusy(null);
    if (!res.ok) {
      if (res.code === "HOLD_EXPIRED") {
        setExpiredByServer(true);
        return;
      }
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/checkout/${bookingId}`)}`);
        return;
      }
      setError(paymentErrorMessage(res.status, res.code, res.message));
      if (res.status === 409) router.refresh();
    } else {
      setError("The payment provider did not return a checkout page. Please try again.");
    }
  }

  async function cancel() {
    if (!window.confirm("Cancel this booking and release your seats?")) return;
    setBusy("cancel");
    setError(null);
    const res = await api(`/api/bookings/${bookingId}/cancel`, { method: "POST", body: {} });
    if (res.ok) {
      router.refresh();
      return;
    }
    setBusy(null);
    setError(res.status >= 500 ? "We couldn't cancel the booking right now. Please try again shortly." : res.message);
    if (res.status === 409) router.refresh();
  }

  if (expired) {
    return (
      <div className="card flex flex-col gap-3 p-5">
        <Alert tone="warning">Your seat hold has expired and the seats have been released.</Alert>
        <Link href={`/showtimes/${showtimeId}`} className="btn-primary">
          Choose seats again
        </Link>
      </div>
    );
  }

  const urgent = remaining < 2 * 60_000;
  return (
    <div className="card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Seats held for</p>
          <p className="text-xs text-subtle">until {holdUntil}</p>
        </div>
        <p
          className={`font-mono text-3xl font-bold tabular-nums ${urgent ? "text-danger" : "text-accent"}`}
          role="timer"
          aria-live="off"
          aria-label={`${mm} minutes ${ss} seconds remaining`}
        >
          {mm}:{ss}
        </p>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <button type="button" onClick={pay} disabled={busy !== null} className="btn-primary min-h-12 text-base">
        {busy === "pay" ? <Spinner /> : null}
        {busy === "pay" ? "Redirecting to payment…" : `Pay ${totalLabel}`}
      </button>
      <button type="button" onClick={cancel} disabled={busy !== null} className="btn-ghost">
        {busy === "cancel" ? <Spinner /> : null}
        {busy === "cancel" ? "Releasing seats…" : "Cancel and release seats"}
      </button>
      <p className="text-xs text-subtle">Payments are processed securely by Stripe. You&apos;ll return here afterwards.</p>
    </div>
  );
}
