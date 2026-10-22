import type { Metadata } from "next";
import Link from "next/link";
import { Poster } from "@/components/poster";
import { EmptyState, PageTitle, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/pricing";
import { formatDateTime, tzLabel } from "@/lib/ui/format";
import { listUserBookings } from "@/server/catalog";
import { db, requireUserPage } from "@/server/context";

export const metadata: Metadata = { title: "My bookings" };

type Booking = Awaited<ReturnType<typeof listUserBookings>>[number];

export default async function BookingsPage() {
  const user = await requireUserPage("/bookings");
  const bookings = await listUserBookings(db, user.id);
  const now = new Date();

  const effectiveStatus = (b: Booking) => (b.status === "PENDING" && b.holdExpiresAt <= now ? "EXPIRED" : b.status);
  const upcoming = bookings
    .filter((b) => b.startsAt > now && (b.status === "CONFIRMED" || effectiveStatus(b) === "PENDING"))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const upcomingIds = new Set(upcoming.map((b) => b.id));
  const other = bookings.filter((b) => !upcomingIds.has(b.id));

  return (
    <div className="container-page py-10">
      <PageTitle eyebrow="Account" title="My bookings">
        Signed in as {user.email}
      </PageTitle>

      {bookings.length === 0 ? (
        <EmptyState title="No bookings yet" action={{ href: "/", label: "Browse movies" }}>
          When you book tickets they&apos;ll show up here, along with your digital tickets.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-10">
          <section aria-labelledby="upcoming">
            <h2 id="upcoming" className="mb-4 text-xl font-bold">
              Upcoming
            </h2>
            {upcoming.length === 0 ? (
              <p className="card p-6 text-sm text-muted">
                No upcoming shows.{" "}
                <Link href="/" className="font-semibold text-accent hover:underline">
                  Find something to watch
                </Link>
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {upcoming.map((b) => (
                  <BookingRow key={b.id} b={b} status={effectiveStatus(b)} />
                ))}
              </ul>
            )}
          </section>
          {other.length ? (
            <section aria-labelledby="past">
              <h2 id="past" className="mb-4 text-xl font-bold">
                Past and other bookings
              </h2>
              <ul className="flex flex-col gap-3">
                {other.map((b) => (
                  <BookingRow key={b.id} b={b} status={effectiveStatus(b)} muted />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function BookingRow({ b, status, muted }: { b: Booking; status: string; muted?: boolean }) {
  const href = status === "PENDING" ? `/checkout/${b.id}` : `/bookings/${b.id}`;
  return (
    <li>
      <Link
        href={href}
        className={`card flex gap-4 p-4 transition-colors hover:border-accent/60 ${muted ? "opacity-80 hover:opacity-100" : ""}`}
      >
        <Poster title={b.movieTitle} posterUrl={b.posterUrl} size="sm" className="w-14 shrink-0 sm:w-16" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-semibold">{b.movieTitle}</h3>
            <StatusBadge status={status} label={status === "PENDING" ? "Awaiting payment" : undefined} />
          </div>
          <p className="text-sm text-muted">
            {formatDateTime(b.startsAt, b.timezone)} {tzLabel(b.startsAt, b.timezone)} · {b.cinemaName} ·{" "}
            {b.auditoriumName}
          </p>
          <p className="text-xs text-subtle">
            {b.seats.length} {b.seats.length === 1 ? "seat" : "seats"} ({b.seats.map((s) => `${s.row}${s.number}`).join(", ")}) ·
            Ref <span className="font-mono">{b.reference}</span>
          </p>
        </div>
        <div className="hidden shrink-0 self-center text-right sm:block">
          <p className="font-semibold tabular-nums">{formatMoney(b.totalMinor, b.currency)}</p>
          <p className="text-xs text-accent">{status === "PENDING" ? "Pay now →" : "View →"}</p>
        </div>
      </Link>
    </li>
  );
}
