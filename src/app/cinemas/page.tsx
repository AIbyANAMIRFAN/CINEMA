import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { EmptyState, PageTitle } from "@/components/ui";
import { listCinemas } from "@/server/catalog";
import { db } from "@/server/context";

export const metadata: Metadata = { title: "Cinemas" };

export default async function CinemasPage() {
  await connection();
  const cinemas = await listCinemas(db);

  return (
    <div className="container-page py-10">
      <PageTitle eyebrow="Cinemas" title="Find a cinema near you">
        Pick a cinema to see what&apos;s playing and book seats.
      </PageTitle>
      {cinemas.length === 0 ? (
        <EmptyState title="No cinemas yet">Check back soon.</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cinemas.map((c) => (
            <li key={c.id}>
              <Link
                href={`/cinemas/${c.slug}`}
                className="card group flex h-full flex-col gap-3 p-5 transition-colors hover:border-accent/60"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-semibold group-hover:text-accent">{c.name}</h2>
                  {c.screens > 0 ? (
                    <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">
                      {c.screens} {c.screens === 1 ? "screen" : "screens"}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm text-muted">{c.address}</p>
                <p className="mt-auto text-xs text-subtle">
                  {c.city} · {c.timezone.replace(/_/g, " ")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
