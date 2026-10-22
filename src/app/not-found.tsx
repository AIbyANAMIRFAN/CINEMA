import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="container-page flex flex-col items-center py-24 text-center">
      <p className="text-7xl font-black tracking-tighter text-accent">404</p>
      <h1 className="mt-4 text-2xl font-bold">This screening doesn&apos;t exist</h1>
      <p className="mt-2 max-w-md text-muted">
        The page you&apos;re looking for may have moved, ended its run, or never existed.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/" className="btn-primary">
          Browse movies
        </Link>
        <Link href="/cinemas" className="btn-secondary">
          Find a cinema
        </Link>
      </div>
    </div>
  );
}
