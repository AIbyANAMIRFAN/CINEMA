import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { SeatPicker } from "@/components/seat-picker";
import { Alert } from "@/components/ui";
import { UUID_RE } from "@/lib/ids";
import { formatMoney } from "@/lib/pricing";
import { formatDateTime, formatDuration, formatTime, tzLabel } from "@/lib/ui/format";
import { getSeatMap, getShowtime, listUserBookings } from "@/server/catalog";
import { db, getCurrentUser } from "@/server/context";

export async function generateMetadata(props: PageProps<"/showtimes/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  if (!UUID_RE.test(id)) return { title: "Showtime not found" };
  const st = await getShowtime(db, id);
  return { title: st ? `Choose seats · ${st.movieTitle}` : "Showtime not found" };
}

export default async function ShowtimePage(props: PageProps<"/showtimes/[id]">) {
  await connection();
  const { id } = await props.params;
  if (!UUID_RE.test(id)) notFound();
  const showtime = await getShowtime(db, id);
  if (!showtime) notFound();

  const user = await getCurrentUser();
  const seats = await getSeatMap(db, id, user?.id);
  const now = new Date();
  const started = showtime.startsAt <= now;
  const cancelled = showtime.status === "CANCELLED";
  const bookable = !started && !cancelled;
  const pending = user
    ? (await listUserBookings(db, user.id)).find(
        (b) => b.showtimeId === id && b.status === "PENDING" && b.holdExpiresAt > now,
      )
    : undefined;

  return (
    <div className="pb-40 lg:pb-0">
      <div className="border-b border-line/60 bg-surface/40">
        <div className="container-page flex flex-col gap-2 py-6">
          <Link href={`/movies/${showtime.movieSlug}#showtimes`} className="text-sm text-muted hover:text-fg">
            ← {showtime.movieTitle}
          </Link>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{showtime.movieTitle}</h1>
          <p className="text-sm text-muted">
            <span className="font-medium text-fg">
              {formatDateTime(showtime.startsAt, showtime.timezone)} {tzLabel(showtime.startsAt, showtime.timezone)}
            </span>{" "}
            · {showtime.cinemaName} · {showtime.auditoriumName} · {showtime.ageRating} ·{" "}
            {formatDuration(showtime.durationMinutes)} · {showtime.language}
          </p>
          <p className="text-xs text-subtle">
            Ends around {formatTime(showtime.endsAt, showtime.timezone)} local time · Tickets from{" "}
            {formatMoney(showtime.basePriceMinor, showtime.currency)}
          </p>
        </div>
      </div>

      <div className="container-page flex flex-col gap-4 pt-6">
        {cancelled ? (
          <Alert tone="error">This showtime has been cancelled and can no longer be booked.</Alert>
        ) : started ? (
          <Alert tone="warning">This showtime has already started, so tickets are no longer on sale.</Alert>
        ) : null}
        {pending ? (
          <Alert tone="info">
            You already have {pending.seats.length} {pending.seats.length === 1 ? "seat" : "seats"} held for this show
            (ref {pending.reference}).{" "}
            <Link href={`/checkout/${pending.id}`} className="font-semibold underline">
              Continue to checkout
            </Link>
          </Alert>
        ) : null}
      </div>

      <SeatPicker
        showtimeId={showtime.id}
        initialSeats={seats}
        currency={showtime.currency}
        bookable={bookable}
        signedIn={Boolean(user)}
      />
    </div>
  );
}
