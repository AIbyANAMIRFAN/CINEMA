"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatMoney } from "@/lib/pricing";
import { api } from "@/lib/ui/api";
import { Alert, Spinner } from "./ui";

export function CancelBookingButton({
  bookingId,
  confirmed,
  currency,
  totalMinor,
}: {
  bookingId: string;
  confirmed: boolean;
  currency: string;
  totalMinor: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function cancel() {
    const question = confirmed
      ? `Cancel this booking? You'll be refunded ${formatMoney(totalMinor, currency)} to your original payment method.`
      : "Cancel this booking and release the held seats?";
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    const res = await api<{ status: "CANCELLED" | "REFUNDED"; refundedMinor: number }>(
      `/api/bookings/${bookingId}/cancel`,
      { method: "POST", body: {} },
    );
    setBusy(false);
    if (res.ok) {
      setResult(
        res.data.status === "REFUNDED"
          ? `Booking cancelled. A refund of ${formatMoney(res.data.refundedMinor, currency)} is on its way.`
          : "Booking cancelled and seats released.",
      );
      router.refresh();
      return;
    }
    setError(res.status >= 500 ? "We couldn't cancel this booking right now. Please try again shortly." : res.message);
  }

  return (
    <div className="flex flex-col gap-3">
      {result ? <Alert tone="success">{result}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!result ? (
        <button type="button" onClick={cancel} disabled={busy} className="btn-danger">
          {busy ? <Spinner /> : null}
          {busy ? "Cancelling…" : confirmed ? "Cancel and refund" : "Cancel booking"}
        </button>
      ) : null}
    </div>
  );
}

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="btn-secondary no-print">
      Print ticket
    </button>
  );
}
