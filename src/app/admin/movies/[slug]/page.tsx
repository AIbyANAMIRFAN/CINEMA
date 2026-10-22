import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MovieForm } from "@/components/admin/movie-form";
import { StatusBadge } from "@/components/ui";
import { getFilterOptions, getMovieBySlug } from "@/server/catalog";
import { db, requireAdminPage } from "@/server/context";

export const metadata: Metadata = { title: "Edit movie" };

export default async function AdminEditMoviePage(props: PageProps<"/admin/movies/[slug]">) {
  const { slug } = await props.params;
  await requireAdminPage(`/admin/movies/${slug}`);
  const [movie, options] = await Promise.all([getMovieBySlug(db, slug), getFilterOptions(db)]);
  if (!movie) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/admin/movies" className="text-sm text-muted hover:text-fg">
          ← All movies
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{movie.title}</h1>
          <StatusBadge status={movie.isActive ? "CONFIRMED" : "CANCELLED"} label={movie.isActive ? "Active" : "Inactive"} />
        </div>
        {movie.isActive ? (
          <Link href={`/movies/${movie.slug}`} className="text-sm text-accent hover:underline">
            View public page →
          </Link>
        ) : null}
      </div>
      <MovieForm
        genres={options.genres}
        initial={{
          id: movie.id,
          title: movie.title,
          synopsis: movie.synopsis,
          durationMinutes: movie.durationMinutes,
          language: movie.language,
          ageRating: movie.ageRating,
          releaseDate: movie.releaseDate,
          posterUrl: movie.posterUrl,
          director: movie.director,
          castList: movie.castList,
          isActive: movie.isActive,
          genreSlugs: movie.genres.map((g) => g.slug),
        }}
      />
    </div>
  );
}
