"use client";

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatMoney } from "@/lib/pricing";
import { api } from "@/lib/ui/api";
import { formatDateTime, tzLabel } from "@/lib/ui/format";
import { Alert, Spinner, StatusBadge } from "../ui";

type VerifyResult = {
  valid: boolean;
  ticket: { code: string; issuedAt: string; revokedAt: string | null };
  booking: {
    id: string;
    reference: string;
    status: string;
    movieTitle: string;
    startsAt: string;
    timezone: string;
    cinemaName: string;
    auditoriumName: string;
    totalMinor: number;
    currency: string;
    seats: { row: string; number: number }[];
  } | null;
};

export function TicketVerifier() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    const code = raw.replace(/^CINEBOOK:/i, "").trim();
    if (!code) {
      setError("Enter a ticket code.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await api<VerifyResult>(`/api/admin/tickets/${encodeURIComponent(code)}`);
    setBusy(false);
    if (res.ok) setResult(res.data);
    else setError(res.status === 404 ? "No ticket found with this code. Do not admit." : res.message);
  }

  const b = result?.booking;
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="card flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="t-code" className="label">
            Ticket code
          </label>
          <input id="t-code" name="code" className="input font-mono" autoComplete="off" spellCheck={false} placeholder="CINEBOOK:…" />
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {busy ? "Checking…" : "Verify"}
        </button>
      </form>
      <div aria-live="polite" className="flex flex-col gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {result ? (
          <div className="card flex flex-col gap-4 p-5">
            <div
              className={`rounded-xl p-4 text-center text-lg font-bold ${result.valid ? "bg-success/15 text-success" : "bg-danger/15 text-danger"}`}
            >
              {result.valid ? "✓ Valid ticket — admit" : "✕ Not valid — do not admit"}
            </div>
            {result.ticket.revokedAt ? <Alert tone="error">This ticket was revoked.</Alert> : null}
            {b ? (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <Item label="Reference">
                  <Link href={`/bookings/${b.id}`} className="font-mono text-accent hover:underline">
                    {b.reference}
                  </Link>
                </Item>
                <Item label="Status">
                  <StatusBadge status={b.status} />
                </Item>
                <Item label="Movie">{b.movieTitle}</Item>
                <Item label="Show">
                  {formatDateTime(b.startsAt, b.timezone)} {tzLabel(b.startsAt, b.timezone)}
                </Item>
                <Item label="Cinema">
                  {b.cinemaName} · {b.auditoriumName}
                </Item>
                <Item label="Seats">{b.seats.map((s) => `${s.row}${s.number}`).join(", ")}</Item>
                <Item label="Paid">{formatMoney(b.totalMinor, b.currency)}</Item>
              </dl>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}
