"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = (error as { digest?: string } | null)?.digest;

  return (
    <div className="container-page flex flex-col items-center py-24 text-center">
      <p className="text-xs font-semibold tracking-[0.25em] text-danger uppercase">Something went wrong</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">We couldn&apos;t load this page</h1>
      <p className="mt-3 max-w-md text-muted">
        This is usually temporary. Try again, or head back to the movie listings.
      </p>
      {digest ? <p className="mt-2 font-mono text-xs text-subtle">Reference: {digest}</p> : null}
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={() => retry()} className="btn-primary">
          Try again
        </button>
        <Link href="/" className="btn-secondary">
          Back to movies
        </Link>
      </div>
    </div>
  );
}
