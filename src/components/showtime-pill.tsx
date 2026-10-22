import Link from "next/link";
import { formatMoney } from "@/lib/pricing";
import { formatTime, tzLabel } from "@/lib/ui/format";

export type ShowtimePillData = {
  id: string;
  startsAt: Date;
  timezone: string;
  seatsAvailable: number;
  seatsTotal: number;
  basePriceMinor: number;
  currency: string;
  auditoriumName: string;
};

export function ShowtimePill({ st }: { st: ShowtimePillData }) {
  const soldOut = st.seatsAvailable <= 0;
  const low = !soldOut && st.seatsAvailable <= Math.max(5, Math.round(st.seatsTotal * 0.15));
  const time = formatTime(st.startsAt, st.timezone);
  const availability = soldOut ? "Sold out" : `${st.seatsAvailable} seats left`;
  const label = `${time} ${tzLabel(st.startsAt, st.timezone)}, ${st.auditoriumName}, ${availability}, from ${formatMoney(st.basePriceMinor, st.currency)}`;

  if (soldOut) {
    return (
      <span
        aria-label={label}
        className="flex min-w-[6.5rem] flex-col rounded-xl border border-line bg-surface px-3 py-2 opacity-50"
      >
        <span className="font-semibold tabular-nums line-through">{time}</span>
        <span className="text-[11px] text-subtle">Sold out</span>
      </span>
    );
  }
  return (
    <Link
      href={`/showtimes/${st.id}`}
      aria-label={label}
      className="group flex min-w-[6.5rem] flex-col rounded-xl border border-line-strong bg-surface-2 px-3 py-2 transition-colors hover:border-accent hover:bg-accent/10"
    >
      <span className="font-semibold tabular-nums group-hover:text-accent">{time}</span>
      <span className="text-[11px] text-subtle">{st.auditoriumName}</span>
      <span className={`mt-0.5 flex items-center gap-1 text-[11px] font-medium ${low ? "text-accent" : "text-success"}`}>
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${low ? "bg-accent" : "bg-success"}`} />
        {availability}
      </span>
    </Link>
  );
}
