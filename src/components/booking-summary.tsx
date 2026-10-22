import { formatMoney } from "@/lib/pricing";
import { formatDateTime, tzLabel } from "@/lib/ui/format";
import { Poster } from "./poster";

export type SummaryBooking = {
  reference: string;
  movieTitle: string;
  posterUrl: string | null;
  ageRating: string;
  cinemaName: string;
  cinemaAddress: string;
  auditoriumName: string;
  startsAt: Date;
  timezone: string;
  currency: string;
  subtotalMinor: number;
  feeMinor: number;
  taxMinor: number;
  totalMinor: number;
  seats: { row: string; number: number; type: string; priceMinor: number }[];
};

export function BookingSummary({ booking }: { booking: SummaryBooking }) {
  const money = (m: number) => formatMoney(m, booking.currency);
  return (
    <div className="card print-plain flex flex-col gap-5 p-5 sm:p-6">
      <div className="flex gap-4">
        <Poster title={booking.movieTitle} posterUrl={booking.posterUrl} size="sm" className="w-20 shrink-0 sm:w-24" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-xs text-subtle">Ref {booking.reference}</p>
          <h2 className="text-xl font-bold">{booking.movieTitle}</h2>
          <p className="text-sm text-muted">
            {formatDateTime(booking.startsAt, booking.timezone)} {tzLabel(booking.startsAt, booking.timezone)}
          </p>
          <p className="text-sm text-muted">
            {booking.cinemaName} · {booking.auditoriumName}
          </p>
          <p className="text-xs text-subtle">{booking.cinemaAddress}</p>
        </div>
      </div>
      <div>
        <h3 className="label">Seats</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {booking.seats.map((s) => (
            <li key={`${s.row}${s.number}`} className="flex justify-between gap-4">
              <span>
                Row {s.row}, seat {s.number}{" "}
                <span className="text-xs text-subtle">({s.type.toLowerCase()})</span>
              </span>
              <span className="tabular-nums">{money(s.priceMinor)}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="flex flex-col gap-1.5 border-t border-line pt-4 text-sm">
        <Line label="Tickets" value={money(booking.subtotalMinor)} />
        <Line label="Service fees" value={money(booking.feeMinor)} />
        <Line label="Tax" value={money(booking.taxMinor)} />
        <div className="mt-1 flex justify-between border-t border-line pt-2 text-base font-bold">
          <dt>Total</dt>
          <dd className="tabular-nums">{money(booking.totalMinor)}</dd>
        </div>
      </dl>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-muted">
      <dt>{label}</dt>
      <dd className="tabular-nums text-fg">{value}</dd>
    </div>
  );
}
