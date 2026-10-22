import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Poster } from "@/components/poster";
import { ShowtimePill } from "@/components/showtime-pill";
import { EmptyState } from "@/components/ui";
import { DATE_KEY_RE, dateKeyLabel, firstParam, formatLongDate, nextDays, tzLabel } from "@/lib/ui/format";
import { getCinemaBySlug, listCinemas, listShowtimes, type ShowtimeListItem } from "@/server/catalog";
import { db } from "@/server/context";

export async function generateMetadata(props: PageProps<"/cinemas/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const cinema = await getCinemaBySlug(db, slug);
  return { title: cinema ? cinema.name : "Cinema not found" };
}

export default async function CinemaPage(props: PageProps<"/cinemas/[slug]">) {
  await connection();
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const cinema = await getCinemaBySlug(db, slug);
  if (!cinema) notFound();

  const days = nextDays(new Date(), cinema.timezone, 7);
  const rawDate = firstParam(sp.date);
  const date = rawDate && DATE_KEY_RE.test(rawDate) ? rawDate : days[0];

  const [showtimes, cinemas] = await Promise.all([
    listShowtimes(db, { cinemaSlug: cinema.slug, date }),
    listCinemas(db),
  ]);
  const screens = cinemas.find((c) => c.slug === cinema.slug)?.screens ?? 0;

  const byMovie = new Map<string, ShowtimeListItem[]>();
  for (const st of showtimes) byMovie.set(st.movieSlug, [...(byMovie.get(st.movieSlug) ?? []), st]);

  return (
    <div className="container-page py-10">
      <div className="mb-8 flex flex-col gap-2">
        <Link href="/cinemas" className="text-sm text-muted hover:text-fg">
          ← All cinemas
        </Link>
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">{cinema.name}</h1>
        <p className="text-muted">{cinema.address}</p>
        <p className="text-sm text-subtle">
          {cinema.city}
          {screens > 0 ? ` · ${screens} ${screens === 1 ? "screen" : "screens"}` : ""} · All times shown in local time (
          {tzLabel(new Date(`${date}T12:00:00Z`), cinema.timezone)})
        </p>
      </div>

      <nav aria-label="Choose a date" className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {days.map((d) => (
          <Link
            key={d}
            href={`/cinemas/${cinema.slug}?date=${d}`}
            scroll={false}
            className={`chip shrink-0 ${date === d ? "chip-active" : ""}`}
            aria-current={date === d ? "date" : undefined}
          >
            {dateKeyLabel(d, days[0])}
          </Link>
        ))}
      </nav>

      <h2 className="mb-4 text-xl font-bold">
        {formatLongDate(new Date(`${date}T12:00:00Z`), "UTC")}
      </h2>

      {byMovie.size === 0 ? (
        <EmptyState title="No showtimes on this day">Try another date — new screenings are added regularly.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {[...byMovie.values()].map((list) => (
            <article key={list[0].movieSlug} className="card grid gap-4 p-4 sm:grid-cols-[96px_1fr]">
              <Link href={`/movies/${list[0].movieSlug}`} className="hidden sm:block" tabIndex={-1} aria-hidden>
                <Poster title={list[0].movieTitle} size="sm" />
              </Link>
              <div>
                <h3 className="mb-3 text-lg font-semibold">
                  <Link href={`/movies/${list[0].movieSlug}`} className="hover:text-accent">
                    {list[0].movieTitle}
                  </Link>
                </h3>
                <div className="flex flex-wrap gap-2">
                  {list.map((st) => (
                    <ShowtimePill key={st.id} st={st} />
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
