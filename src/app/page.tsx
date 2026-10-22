import Link from "next/link";
import { Suspense } from "react";
import { MovieCard, MovieGridSkeleton } from "@/components/movie-card";
import { MovieFilters } from "@/components/movie-filters";
import { Alert, EmptyState } from "@/components/ui";
import { DATE_KEY_RE, dateKeyLabel, firstParam, nextDays } from "@/lib/ui/format";
import { getCinemaBySlug, getFilterOptions, listMovies } from "@/server/catalog";
import { db } from "@/server/context";

const DEFAULT_TZ = "America/New_York";

export default function HomePage(props: PageProps<"/">) {
  return (
    <>
      <section className="relative overflow-hidden border-b border-line/60">
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(600px 300px at 15% 20%, rgb(245 182 63 / 0.18), transparent 70%), radial-gradient(500px 300px at 85% 0%, rgb(180 140 255 / 0.16), transparent 70%)",
          }}
        />
        <div className="container-page relative py-12 sm:py-20">
          <p className="text-xs font-semibold tracking-[0.25em] text-accent uppercase">Now showing</p>
          <h1 className="mt-3 max-w-2xl text-4xl leading-[1.05] font-black tracking-tight text-balance sm:text-6xl">
            Your seat is waiting.
          </h1>
          <p className="mt-4 max-w-xl text-base text-muted sm:text-lg">
            Browse what&apos;s on, choose the perfect seat on a live seat map and check out in under a minute.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <a href="#movies" className="btn-primary">
              Browse movies
            </a>
            <Link href="/cinemas" className="btn-secondary">
              Find a cinema
            </Link>
          </div>
        </div>
      </section>

      <section id="movies" className="container-page scroll-mt-20 py-10">
        <Suspense
          fallback={
            <div className="flex flex-col gap-6">
              <div className="skeleton h-24" />
              <div className="skeleton h-9 w-2/3" />
              <MovieGridSkeleton />
            </div>
          }
        >
          <Catalog searchParams={props.searchParams} />
        </Suspense>
      </section>
    </>
  );
}

async function Catalog({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const sp = await searchParams;
  const q = firstParam(sp.q)?.trim().slice(0, 100) || undefined;
  const genre = firstParam(sp.genre) || undefined;
  const language = firstParam(sp.language) || undefined;
  const cinema = firstParam(sp.cinema) || undefined;
  const rawDate = firstParam(sp.date);
  const date = rawDate && DATE_KEY_RE.test(rawDate) ? rawDate : undefined;
  const forbidden = firstParam(sp.error) === "forbidden";

  const [options, movies] = await Promise.all([
    getFilterOptions(db),
    listMovies(db, { q, genre, language, cinema, date }),
  ]);

  const tz = (cinema && (await getCinemaBySlug(db, cinema))?.timezone) || DEFAULT_TZ;
  const days = nextDays(new Date(), tz, 7);
  const today = days[0];

  const base = new URLSearchParams();
  if (q) base.set("q", q);
  if (genre) base.set("genre", genre);
  if (language) base.set("language", language);
  if (cinema) base.set("cinema", cinema);
  const hrefWith = (d?: string) => {
    const p = new URLSearchParams(base);
    if (d) p.set("date", d);
    const s = p.toString();
    return `/${s ? `?${s}` : ""}#movies`;
  };
  const detailQuery = new URLSearchParams();
  if (cinema) detailQuery.set("cinema", cinema);
  if (date) detailQuery.set("date", date);
  const anyFilter = Boolean(q || genre || language || cinema || date);

  return (
    <div className="flex flex-col gap-6">
      {forbidden ? <Alert tone="error">That area is for administrators only.</Alert> : null}
      <MovieFilters
        values={{ q, genre, language, cinema, date }}
        genres={options.genres.map((g) => ({ value: g.slug, label: g.name }))}
        languages={options.languages.map((l) => ({ value: l, label: l }))}
        cinemas={options.cinemas.map((c) => ({ value: c.slug, label: `${c.name} · ${c.city}` }))}
      />

      <nav aria-label="Filter by date" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        <Link href={hrefWith()} scroll={false} className={`chip shrink-0 ${!date ? "chip-active" : ""}`} aria-current={!date ? "true" : undefined}>
          Any day
        </Link>
        {days.map((d) => (
          <Link
            key={d}
            href={hrefWith(d)}
            scroll={false}
            className={`chip shrink-0 ${date === d ? "chip-active" : ""}`}
            aria-current={date === d ? "true" : undefined}
          >
            {dateKeyLabel(d, today)}
          </Link>
        ))}
      </nav>

      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-bold">
          {movies.length} {movies.length === 1 ? "movie" : "movies"}
          {date ? <span className="font-normal text-muted"> · {dateKeyLabel(date, today)}</span> : null}
        </h2>
        {anyFilter ? (
          <Link href="/#movies" className="text-sm text-accent hover:underline">
            Clear filters
          </Link>
        ) : null}
      </div>

      {movies.length === 0 ? (
        <EmptyState title="No movies match your filters" action={{ href: "/#movies", label: "Clear filters" }}>
          Try a different title, genre or day — or pick another cinema.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
          {movies.map((m) => (
            <MovieCard key={m.id} movie={m} query={detailQuery.toString()} />
          ))}
        </div>
      )}
    </div>
  );
}
