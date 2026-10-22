import type { Metadata } from "next";
import Link from "next/link";
import { MovieActiveToggle, MovieForm, type MovieFormValues } from "@/components/admin/movie-form";
import { EmptyState, StatusBadge } from "@/components/ui";
import { formatDuration } from "@/lib/ui/format";
import { adminListMovies } from "@/server/admin";
import { getFilterOptions } from "@/server/catalog";
import { db, requireAdminPage } from "@/server/context";

export const metadata: Metadata = { title: "Movies" };

const EMPTY_MOVIE: MovieFormValues = {
  title: "",
  synopsis: "",
  durationMinutes: "",
  language: "English",
  ageRating: "PG-13",
  releaseDate: "",
  posterUrl: null,
  director: null,
  castList: null,
  isActive: true,
  genreSlugs: [],
};

export default async function AdminMoviesPage() {
  await requireAdminPage("/admin/movies");
  const [movies, options] = await Promise.all([adminListMovies(db), getFilterOptions(db)]);

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="movies-title">
        <h1 id="movies-title" className="mb-4 text-2xl font-bold tracking-tight">
          Movies <span className="text-base font-normal text-subtle">({movies.length})</span>
        </h1>
        {movies.length === 0 ? (
          <EmptyState title="No movies yet">Create the first one below.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Language</th>
                  <th scope="col">Runtime</th>
                  <th scope="col">Upcoming shows</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {movies.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <p className="font-semibold">{m.title}</p>
                      <p className="text-xs text-subtle">Released {m.releaseDate}</p>
                    </td>
                    <td className="text-muted">{m.language}</td>
                    <td className="text-muted">{formatDuration(m.durationMinutes)}</td>
                    <td className="tabular-nums">{m.upcomingShowtimes}</td>
                    <td>
                      <StatusBadge status={m.isActive ? "CONFIRMED" : "CANCELLED"} label={m.isActive ? "Active" : "Inactive"} />
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-2">
                        <MovieActiveToggle id={m.id} isActive={m.isActive} />
                        <Link href={`/admin/movies/${m.slug}`} className="btn-secondary min-h-8 px-2 py-1">
                          Edit
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="new-movie">
        <h2 id="new-movie" className="mb-4 text-xl font-bold">
          Add a movie
        </h2>
        <MovieForm initial={EMPTY_MOVIE} genres={options.genres} />
      </section>
    </div>
  );
}
