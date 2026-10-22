"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_SEATS_PER_BOOKING, SERVICE_FEE_PER_SEAT_MINOR, TAX_RATE_BPS, calculateTotals, formatMoney } from "@/lib/pricing";
import { api } from "@/lib/ui/api";
import { Alert, Spinner } from "./ui";

export type Seat = {
  id: string;
  row: string;
  number: number;
  type: "STANDARD" | "PREMIUM" | "ACCESSIBLE";
  priceMinor: number;
  status: "AVAILABLE" | "HELD" | "BOOKED" | "BLOCKED";
  mine: boolean;
};

const POLL_MS = 12_000;
const TYPE_LABEL = { STANDARD: "standard", PREMIUM: "premium", ACCESSIBLE: "wheelchair accessible" } as const;

const storageKey = (showtimeId: string) => `cinebook:selection:${showtimeId}`;

export function SeatPicker({
  showtimeId,
  initialSeats,
  currency,
  bookable,
  signedIn,
}: {
  showtimeId: string;
  initialSeats: Seat[];
  currency: string;
  bookable: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [seats, setSeats] = useState<Seat[]>(initialSeats);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const byId = useMemo(() => new Map(seats.map((s) => [s.id, s])), [seats]);
  const label = useCallback((s: Seat) => `${s.row}${s.number}`, []);

  // Restore a selection saved before a sign-in redirect.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey(showtimeId));
      if (!raw) return;
      const ids = (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string");
      const ok = ids.filter((id) => initialSeats.find((s) => s.id === id)?.status === "AVAILABLE");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from browser storage
      if (ok.length) setSelected(ok.slice(0, MAX_SEATS_PER_BOOKING));
    } catch {
      // storage unavailable
    }
  }, [showtimeId, initialSeats]);

  useEffect(() => {
    try {
      if (selected.length) sessionStorage.setItem(storageKey(showtimeId), JSON.stringify(selected));
      else sessionStorage.removeItem(storageKey(showtimeId));
    } catch {
      // storage unavailable
    }
  }, [selected, showtimeId]);

  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const applySeats = useCallback(
    (fresh: Seat[]) => {
      setSeats(fresh);
      const freshById = new Map(fresh.map((s) => [s.id, s]));
      const lost = selectedRef.current.filter((id) => freshById.get(id)?.status !== "AVAILABLE");
      if (!lost.length) return;
      const names = lost.map((id) => freshById.get(id)).filter((s): s is Seat => Boolean(s)).map(label);
      setSelected((cur) => cur.filter((id) => !lost.includes(id)));
      setNotice(
        `${names.join(", ") || "Some seats"} ${names.length === 1 ? "was" : "were"} just taken by someone else and removed from your selection.`,
      );
    },
    [label],
  );

  const refresh = useCallback(async () => {
    const res = await api<{ seats: Seat[] }>(`/api/showtimes/${showtimeId}/seats`);
    if (res.ok) applySeats(res.data.seats);
    return res.ok;
  }, [applySeats, showtimeId]);

  // Keep availability fresh while the page is visible.
  useEffect(() => {
    if (!bookable) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [bookable, refresh]);

  const rows = useMemo(() => {
    const map = new Map<string, Seat[]>();
    for (const s of seats) map.set(s.row, [...(map.get(s.row) ?? []), s]);
    const list = [...map.entries()].sort(([a], [b]) => (a.length - b.length) || a.localeCompare(b));
    for (const [, r] of list) r.sort((a, b) => a.number - b.number);
    return list;
  }, [seats]);
  const maxNumber = useMemo(() => seats.reduce((m, s) => Math.max(m, s.number), 0), [seats]);
  const hasType = (t: Seat["type"]) => seats.some((s) => s.type === t);

  const selectedSeats = selected.map((id) => byId.get(id)).filter((s): s is Seat => Boolean(s));
  const totals = calculateTotals(selectedSeats.map((s) => s.priceMinor));
  const money = (m: number) => formatMoney(m, currency);

  function toggle(seat: Seat) {
    setError(null);
    if (selected.includes(seat.id)) {
      setSelected(selected.filter((id) => id !== seat.id));
      return;
    }
    if (selected.length >= MAX_SEATS_PER_BOOKING) {
      setNotice(`You can select up to ${MAX_SEATS_PER_BOOKING} seats per booking.`);
      return;
    }
    setNotice(null);
    setSelected([...selected, seat.id]);
  }

  async function onContinue() {
    if (!selectedSeats.length || submitting) return;
    const next = `/showtimes/${showtimeId}`;
    if (!signedIn) {
      router.push(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    setSubmitting(true);
    setError(null);
    setNotice(null);
    // One idempotency key per selection attempt; a retry of the same selection reuses it.
    const seatIds = [...selected].sort();
    const signature = seatIds.join(",");
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };

    const res = await api<{ booking: { bookingId: string } }>("/api/bookings", {
      body: { showtimeId, seatIds, idempotencyKey: attempt.current.key },
    });
    if (res.ok) {
      try {
        sessionStorage.removeItem(storageKey(showtimeId));
      } catch {
        // ignore
      }
      router.push(`/checkout/${res.data.booking.bookingId}`);
      return;
    }
    setSubmitting(false);
    if (res.status === 401) {
      router.push(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (res.code === "SEATS_UNAVAILABLE") {
      const taken = ((res.details as { seatIds?: string[] } | undefined)?.seatIds ?? []).filter(Boolean);
      const names = taken.map((id) => byId.get(id)).filter(Boolean).map((s) => label(s!));
      if (taken.length) setSelected((cur) => cur.filter((id) => !taken.includes(id)));
      attempt.current = null;
      setError(
        names.length
          ? `Sorry — ${names.join(", ")} ${names.length === 1 ? "is" : "are"} no longer available. We've updated the map; please adjust your selection.`
          : "Some of your seats are no longer available. We've updated the map; please review your selection.",
      );
      await refresh();
      return;
    }
    setError(res.message);
  }

  if (!seats.length) {
    return (
      <div className="container-page py-10">
        <Alert tone="info">No seats are configured for this screen yet.</Alert>
      </div>
    );
  }

  const summaryList = selectedSeats.length ? (
    <ul className="flex flex-wrap gap-1.5" aria-label="Selected seats">
      {selectedSeats.map((s) => (
        <li key={s.id}>
          <button
            type="button"
            onClick={() => toggle(s)}
            className="rounded-lg border border-accent/40 bg-accent/10 px-2 py-1 text-xs font-semibold text-accent hover:bg-accent/20"
            aria-label={`Remove row ${s.row} seat ${s.number}`}
          >
            {label(s)} · {money(s.priceMinor)} ✕
          </button>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-muted">Select up to {MAX_SEATS_PER_BOOKING} seats on the map.</p>
  );

  const continueLabel = !bookable
    ? "Not available"
    : !signedIn
      ? "Sign in to continue"
      : submitting
        ? "Holding seats…"
        : selectedSeats.length
          ? `Continue · ${money(totals.totalMinor)}`
          : "Continue";

  const continueButton = (
    <button
      type="button"
      onClick={onContinue}
      disabled={!bookable || submitting || selectedSeats.length === 0}
      className="btn-primary w-full"
    >
      {submitting ? <Spinner /> : null}
      {continueLabel}
    </button>
  );

  return (
    <div className="container-page grid gap-6 py-6 lg:grid-cols-[1fr_340px] lg:items-start">
      <section aria-label="Seat map" className="card min-w-0 p-4 sm:p-6">
        <div aria-live="polite" className="mb-4 flex flex-col gap-2 empty:hidden">
          {notice ? <Alert tone="warning">{notice}</Alert> : null}
          {error ? <Alert tone="error">{error}</Alert> : null}
        </div>

        <div className="overflow-x-auto pb-2">
          <div className="mx-auto w-max min-w-full">
            <div className="mb-8 flex flex-col items-center gap-2" aria-hidden>
              <div className="h-2 w-4/5 rounded-[100%] bg-gradient-to-b from-accent/80 to-accent/0 shadow-[0_8px_40px_rgba(245,182,63,0.35)]" />
              <span className="text-[11px] font-semibold tracking-[0.4em] text-subtle uppercase">Screen</span>
            </div>
            <div className="flex flex-col gap-1.5 sm:gap-2">
              {rows.map(([row, list]) => {
                const slots = new Map(list.map((s) => [s.number, s]));
                return (
                  <div key={row} className="flex items-center justify-center gap-1 sm:gap-1.5">
                    <span className="w-5 shrink-0 text-center text-xs font-semibold text-subtle" aria-hidden>
                      {row}
                    </span>
                    {Array.from({ length: maxNumber }, (_, i) => {
                      const s = slots.get(i + 1);
                      if (!s) return <span key={i} className="h-7 w-7 shrink-0 sm:h-8 sm:w-8" aria-hidden />;
                      return (
                        <SeatButton
                          key={s.id}
                          seat={s}
                          selected={selected.includes(s.id)}
                          disabled={!bookable}
                          price={money(s.priceMinor)}
                          onToggle={toggle}
                        />
                      );
                    })}
                    <span className="w-5 shrink-0 text-center text-xs font-semibold text-subtle" aria-hidden>
                      {row}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4 text-xs text-muted" aria-label="Legend">
          <Legend className="border-line-strong bg-surface-3">Available</Legend>
          {hasType("PREMIUM") ? <Legend className="border-premium/70 bg-premium/20">Premium</Legend> : null}
          {hasType("ACCESSIBLE") ? <Legend className="border-accessible/70 bg-accessible/20">Accessible</Legend> : null}
          <Legend className="border-accent bg-accent">Selected</Legend>
          <Legend className="border-info bg-info/40">Held by you</Legend>
          <Legend className="seat-held border-line bg-surface-2">Held</Legend>
          <Legend className="border-transparent bg-line">Booked</Legend>
          <Legend className="border-dashed border-line-strong bg-transparent">Unavailable</Legend>
        </ul>
        <p className="mt-3 text-[11px] text-subtle">Availability refreshes automatically while this page is open.</p>
      </section>

      {/* Desktop summary */}
      <aside className="card sticky top-24 hidden flex-col gap-4 p-5 lg:flex" aria-label="Booking summary">
        <h2 className="text-lg font-semibold">Your seats</h2>
        {summaryList}
        <Breakdown count={selectedSeats.length} totals={totals} money={money} />
        {continueButton}
        <p className="text-xs text-subtle">Seats are held for a few minutes while you check out.</p>
      </aside>

      {/* Mobile sticky bar */}
      <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ink/95 backdrop-blur lg:hidden" aria-label="Booking summary">
        <div className="container-page flex flex-col gap-3 py-3">
          {selectedSeats.length ? (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm">
                <span>
                  <span className="font-semibold">{selectedSeats.length}</span>{" "}
                  {selectedSeats.length === 1 ? "seat" : "seats"}: {selectedSeats.map(label).join(", ")}
                </span>
                <span className="text-xs text-accent group-open:hidden">Details</span>
                <span className="hidden text-xs text-accent group-open:inline">Hide</span>
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {summaryList}
                <Breakdown count={selectedSeats.length} totals={totals} money={money} />
              </div>
            </details>
          ) : (
            <p className="text-sm text-muted">Tap seats to select (max {MAX_SEATS_PER_BOOKING}).</p>
          )}
          {continueButton}
        </div>
      </div>
    </div>
  );
}

function SeatButton({
  seat,
  selected,
  disabled,
  price,
  onToggle,
}: {
  seat: Seat;
  selected: boolean;
  disabled: boolean;
  price: string;
  onToggle: (s: Seat) => void;
}) {
  const available = seat.status === "AVAILABLE";
  let cls = "border-line-strong bg-surface-3 hover:border-accent hover:bg-accent/30";
  if (seat.type === "PREMIUM") cls = "border-premium/70 bg-premium/20 hover:border-accent hover:bg-accent/30";
  if (seat.type === "ACCESSIBLE") cls = "border-accessible/70 bg-accessible/20 hover:border-accent hover:bg-accent/30";
  let state = "";
  if (selected) {
    cls = "border-accent bg-accent text-accent-ink";
    state = ", selected";
  } else if (seat.mine) {
    cls = "border-info bg-info/40 cursor-not-allowed";
    state = ", held by you";
  } else if (seat.status === "HELD") {
    cls = "seat-held border-line bg-surface-2 cursor-not-allowed";
    state = ", temporarily held";
  } else if (seat.status === "BOOKED") {
    cls = "border-transparent bg-line cursor-not-allowed";
    state = ", booked";
  } else if (seat.status === "BLOCKED") {
    cls = "border-dashed border-line-strong bg-transparent cursor-not-allowed";
    state = ", unavailable";
  }
  const aria = `Row ${seat.row} seat ${seat.number}, ${TYPE_LABEL[seat.type]}, ${price}${state}`;
  return (
    <button
      type="button"
      aria-label={aria}
      aria-pressed={available ? selected : undefined}
      disabled={!available || (disabled && !selected)}
      onClick={() => onToggle(seat)}
      title={aria}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-t-lg rounded-b-sm border text-[10px] font-semibold transition-colors disabled:cursor-not-allowed sm:h-8 sm:w-8 ${cls}`}
    >
      {selected ? seat.number : seat.type === "ACCESSIBLE" && available ? <span aria-hidden>♿</span> : seat.status === "BOOKED" ? <span aria-hidden className="text-subtle">×</span> : null}
    </button>
  );
}

function Legend({ className, children }: { className: string; children: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className={`inline-block h-4 w-4 rounded-t-md rounded-b-sm border ${className}`} />
      {children}
    </li>
  );
}

function Breakdown({
  count,
  totals,
  money,
}: {
  count: number;
  totals: ReturnType<typeof calculateTotals>;
  money: (m: number) => string;
}) {
  return (
    <dl className="flex flex-col gap-1.5 border-t border-line pt-3 text-sm">
      <Row label={`Tickets (${count})`} value={money(totals.subtotalMinor)} />
      <Row label={`Service fee (${money(SERVICE_FEE_PER_SEAT_MINOR)} × ${count})`} value={money(totals.feeMinor)} />
      <Row label={`Tax (${(TAX_RATE_BPS / 100).toFixed(2).replace(/\.00$/, "")}%)`} value={money(totals.taxMinor)} />
      <div className="mt-1 flex justify-between border-t border-line pt-2 text-base font-bold">
        <dt>Total</dt>
        <dd className="tabular-nums">{money(totals.totalMinor)}</dd>
      </div>
    </dl>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-muted">
      <dt>{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
}
