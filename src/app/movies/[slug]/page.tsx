import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Poster } from "@/components/poster";
import { ShowtimePill } from "@/components/showtime-pill";
import { EmptyState } from "@/components/ui";
import { DATE_KEY_RE, dateKeyLabel, firstParam, formatDuration, formatLongDate, localDateKey, nextDays, tzLabel } from "@/lib/ui/format";
import { getMovieBySlug, listCinemas, listShowtimes, type ShowtimeListItem } from "@/server/catalog";
import { db } from "@/server/context";

const DEFAULT_TZ = "America/New_York";

export async function generateMetadata(props: PageProps<"/movies/[slug]">): Promise<Metadata> {
  const { slug } = await props.params;
  const movie = await getMovieBySlug(db, slug);
  if (!movie || !movie.isActive) return { title: "Movie not found" };
  return { title: movie.title, description: movie.synopsis.slice(0, 160) };
}

export default async function MoviePage(props: PageProps<"/movies/[slug]">) {
  await connection();
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const movie = await getMovieBySlug(db, slug);
  if (!movie || !movie.isActive) notFound();

  const cinemaSlug = firstParam(sp.cinema) || undefined;
  const rawDate = firstParam(sp.date);
  const date = rawDate && DATE_KEY_RE.test(rawDate) ? rawDate : undefined;

  const [showtimes, cinemas] = await Promise.all([
    listShowtimes(db, { movieId: movie.id, cinemaSlug, date }),
    listCinemas(db),
  ]);
  const tz = cinemas.find((c) => c.slug === cinemaSlug)?.timezone ?? cinemas[0]?.timezone ?? DEFAULT_TZ;
  const days = nextDays(new Date(), tz, 7);

  const href = (next: { cinema?: string; date?: string }) => {
    const p = new URLSearchParams();
    if (next.cinema) p.set("cinema", next.cinema);
    if (next.date) p.set("date", next.date);
    const s = p.toString();
    return `/movies/${movie.slug}${s ? `?${s}` : ""}#showtimes`;
  };

  const cast = movie.castList?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  return (
    <div>
      <section className="relative overflow-hidden border-b border-line/60">
        <div aria-hidden className="absolute inset-0 scale-110 opacity-30 blur-3xl">
          <Poster title={movie.title} posterUrl={movie.posterUrl} className="h-full w-full rounded-none" />
        </div>
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-ink/40 to-ink" />
        <div className="container-page relative grid gap-8 py-10 sm:grid-cols-[220px_1fr] sm:py-14 lg:grid-cols-[280px_1fr]">
          <Poster title={movie.title} posterUrl={movie.posterUrl} size="lg" className="mx-auto w-48 shadow-2xl shadow-black/60 sm:w-full" />
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-2">
              {movie.genres.map((g) => (
                <Link key={g.slug} href={`/?genre=${g.slug}#movies`} className="chip py-1 text-xs">
                  {g.name}
                </Link>
              ))}
            </div>
            <h1 className="text-3xl font-black tracking-tight text-balance sm:text-5xl">{movie.title}</h1>
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Meta label="Rating" value={movie.ageRating} />
              <Meta label="Runtime" value={formatDuration(movie.durationMinutes)} />
              <Meta label="Language" value={movie.language} />
              <Meta label="Released" value={new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${movie.releaseDate}T00:00:00Z`))} />
            </dl>
            <p className="max-w-2xl leading-relaxed text-muted">{movie.synopsis}</p>
            <dl className="grid max-w-2xl gap-3 text-sm sm:grid-cols-2">
              {movie.director ? (
                <div>
                  <dt className="label">Director</dt>
                  <dd>{movie.director}</dd>
                </div>
              ) : null}
              {cast.length ? (
                <div>
                  <dt className="label">Cast</dt>
                  <dd>{cast.join(", ")}</dd>
                </div>
              ) : null}
            </dl>
            <div>
              <a href="#showtimes" className="btn-primary">
                Get tickets
              </a>
            </div>
          </div>
        </div>
      </section>

      <section id="showtimes" className="container-page scroll-mt-20 py-10">
        <h2 className="mb-4 text-2xl font-bold">Showtimes</h2>
        <div className="mb-6 flex flex-col gap-3">
          <nav aria-label="Filter by cinema" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            <Link href={href({ date })} scroll={false} className={`chip shrink-0 ${!cinemaSlug ? "chip-active" : ""}`}>
              All cinemas
            </Link>
            {cinemas.map((c) => (
              <Link
                key={c.slug}
                href={href({ cinema: c.slug, date })}
                scroll={false}
                className={`chip shrink-0 ${cinemaSlug === c.slug ? "chip-active" : ""}`}
              >
                {c.name}
              </Link>
            ))}
          </nav>
          <nav aria-label="Filter by date" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            <Link href={href({ cinema: cinemaSlug })} scroll={false} className={`chip shrink-0 ${!date ? "chip-active" : ""}`}>
              All dates
            </Link>
            {days.map((d) => (
              <Link
                key={d}
                href={href({ cinema: cinemaSlug, date: d })}
                scroll={false}
                className={`chip shrink-0 ${date === d ? "chip-active" : ""}`}
              >
                {dateKeyLabel(d, days[0])}
              </Link>
            ))}
          </nav>
        </div>

        {showtimes.length === 0 ? (
          <EmptyState title="No showtimes found" action={cinemaSlug || date ? { href: href({}), label: "Show all showtimes" } : undefined}>
            There are no upcoming screenings{cinemaSlug || date ? " for these filters" : " for this movie yet"}.
          </EmptyState>
        ) : (
          <ShowtimesByDate showtimes={showtimes} />
        )}
      </section>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-subtle">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

function ShowtimesByDate({ showtimes }: { showtimes: ShowtimeListItem[] }) {
  const byDate = new Map<string, Map<string, ShowtimeListItem[]>>();
  for (const st of showtimes) {
    const key = localDateKey(st.startsAt, st.timezone);
    const cinemaMap = byDate.get(key) ?? new Map<string, ShowtimeListItem[]>();
    cinemaMap.set(st.cinemaSlug, [...(cinemaMap.get(st.cinemaSlug) ?? []), st]);
    byDate.set(key, cinemaMap);
  }
  return (
    <div className="flex flex-col gap-8">
      {[...byDate.entries()].map(([key, cinemaMap]) => {
        const first = [...cinemaMap.values()][0][0];
        return (
          <section key={key} aria-labelledby={`d-${key}`}>
            <h3 id={`d-${key}`} className="mb-3 text-lg font-semibold">
              {formatLongDate(first.startsAt, first.timezone)}
            </h3>
            <div className="flex flex-col gap-3">
              {[...cinemaMap.entries()].map(([cslug, list]) => (
                <div key={cslug} className="card p-4">
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <Link href={`/cinemas/${cslug}`} className="font-semibold hover:text-accent">
                      {list[0].cinemaName}
                      <span className="ml-2 text-sm font-normal text-subtle">{list[0].cinemaCity}</span>
                    </Link>
                    <span className="text-xs text-subtle">Times in {tzLabel(list[0].startsAt, list[0].timezone)} (local)</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {list.map((st) => (
                      <ShowtimePill key={st.id} st={st} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
