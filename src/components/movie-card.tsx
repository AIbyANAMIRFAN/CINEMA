import Link from "next/link";
import { formatDuration } from "@/lib/ui/format";
import { Poster } from "./poster";

export type MovieCardData = {
  title: string;
  slug: string;
  durationMinutes: number;
  language: string;
  ageRating: string;
  posterUrl: string | null;
  nextShowAt: Date | null;
  genres: { name: string; slug: string }[];
};

export function MovieCard({ movie, query }: { movie: MovieCardData; query?: string }) {
  const href = `/movies/${movie.slug}${query ? `?${query}` : ""}`;
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-2xl p-1 transition-transform focus-visible:outline-offset-4 hover:-translate-y-0.5"
    >
      <div className="relative">
        <Poster
          title={movie.title}
          posterUrl={movie.posterUrl}
          className="shadow-lg shadow-black/40 ring-1 ring-white/5 transition group-hover:ring-accent/50"
        />
        <span className="absolute top-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white backdrop-blur">
          {movie.ageRating}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-1">
        <h3 className="leading-snug font-semibold group-hover:text-accent">{movie.title}</h3>
        <p className="text-xs text-muted">
          {formatDuration(movie.durationMinutes)} · {movie.language}
        </p>
        {movie.genres.length ? (
          <p className="truncate text-xs text-subtle">{movie.genres.map((g) => g.name).join(", ")}</p>
        ) : null}
        <p className={`text-xs font-medium ${movie.nextShowAt ? "text-success" : "text-subtle"}`}>
          {movie.nextShowAt ? "Tickets available" : "No upcoming shows"}
        </p>
      </div>
    </Link>
  );
}

export function MovieGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 p-1">
          <div className="skeleton aspect-[2/3]" />
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
