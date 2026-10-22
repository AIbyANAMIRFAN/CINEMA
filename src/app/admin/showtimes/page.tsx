import type { Metadata } from "next";
import Link from "next/link";
import { CancelShowtimeButton, ShowtimeForm } from "@/components/admin/showtime-admin";
import { EmptyState, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/pricing";
import { formatDateTime, tzLabel } from "@/lib/ui/format";
import { adminListAuditoriums, adminListMovies, adminListShowtimes } from "@/server/admin";
import { db, requireAdminPage } from "@/server/context";

export const metadata: Metadata = { title: "Showtimes" };

export default async function AdminShowtimesPage() {
  await requireAdminPage("/admin/showtimes");
  const [showtimes, movies, auditoriums] = await Promise.all([
    adminListShowtimes(db),
    adminListMovies(db),
    adminListAuditoriums(db),
  ]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="new-st">
        <h1 id="new-st" className="mb-4 text-2xl font-bold tracking-tight">
          Schedule a showtime
        </h1>
        <ShowtimeForm
          movies={movies.map((m) => ({ id: m.id, title: m.title, isActive: m.isActive }))}
          auditoriums={auditoriums}
        />
      </section>

      <section aria-labelledby="st-list">
        <h2 id="st-list" className="mb-4 text-xl font-bold">
          Showtimes <span className="text-base font-normal text-subtle">(from the last 24 hours on, in cinema local time)</span>
        </h2>
        {showtimes.length === 0 ? (
          <EmptyState title="No showtimes scheduled" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Starts</th>
                  <th scope="col">Movie</th>
                  <th scope="col">Cinema · screen</th>
                  <th scope="col">Base price</th>
                  <th scope="col">Sold</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {showtimes.map((s) => {
                  const when = `${formatDateTime(s.startsAt, s.timezone)} ${tzLabel(s.startsAt, s.timezone)}`;
                  const past = s.startsAt <= now;
                  return (
                    <tr key={s.id} className={past ? "opacity-60" : undefined}>
                      <td className="whitespace-nowrap">
                        <Link href={`/showtimes/${s.id}`} className="hover:text-accent">
                          {when}
                        </Link>
                      </td>
                      <td className="font-medium">{s.movieTitle}</td>
                      <td className="text-muted">
                        {s.cinemaName} · {s.auditoriumName}
                      </td>
                      <td className="tabular-nums">{formatMoney(s.basePriceMinor, s.currency)}</td>
                      <td className="tabular-nums">
                        {s.booked}/{s.total}
                      </td>
                      <td>
                        <StatusBadge status={past && s.status === "SCHEDULED" ? "EXPIRED" : s.status} label={past && s.status === "SCHEDULED" ? "Started" : undefined} />
                      </td>
                      <td className="text-right">
                        {s.status === "SCHEDULED" && !past ? (
                          <CancelShowtimeButton id={s.id} label={`${s.movieTitle} at ${when}`} />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
