import Link from "next/link";
import { Suspense } from "react";
import { getCurrentUser } from "@/server/context";
import { LogoutButton } from "./logout-button";

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-black tracking-tight" aria-label="CineBook home">
      <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-accent-ink">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
          <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 0 0 4v0a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v0a2 2 0 0 0 0-4v-3a2 2 0 0 0 0-4V5Zm5 3v8l7-4-7-4Z" />
        </svg>
      </span>
      <span className="text-lg">
        Cine<span className="text-accent">Book</span>
      </span>
    </Link>
  );
}

async function UserMenu() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="flex items-center gap-1">
        <Link href="/login" className="btn-ghost">
          Sign in
        </Link>
        <Link href="/register" className="btn-primary hidden sm:inline-flex">
          Create account
        </Link>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {user.role === "ADMIN" ? (
        <Link href="/admin" className="btn-ghost">
          Admin
        </Link>
      ) : null}
      <Link href="/bookings" className="btn-ghost">
        My bookings
      </Link>
      <span className="hidden max-w-[10rem] truncate px-2 text-sm text-subtle lg:inline" title={user.email}>
        {user.name}
      </span>
      <LogoutButton />
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="no-print sticky top-0 z-40 border-b border-line/70 bg-ink/80 backdrop-blur-md">
      <div className="container-page flex h-16 items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-6">
          <Logo />
          <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
            <Link href="/" className="btn-ghost">
              Movies
            </Link>
            <Link href="/cinemas" className="btn-ghost">
              Cinemas
            </Link>
          </nav>
        </div>
        <Suspense fallback={<div className="skeleton h-9 w-36" aria-hidden />}>
          <UserMenu />
        </Suspense>
      </div>
      <nav aria-label="Main mobile" className="container-page flex gap-1 pb-2 sm:hidden">
        <Link href="/" className="btn-ghost min-h-8 px-3 py-1">
          Movies
        </Link>
        <Link href="/cinemas" className="btn-ghost min-h-8 px-3 py-1">
          Cinemas
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="no-print mt-16 border-t border-line/70">
      <div className="container-page flex flex-col gap-2 py-8 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between">
        <p>CineBook · Showtimes are listed in each cinema&apos;s local time.</p>
        <nav aria-label="Footer" className="flex gap-4">
          <Link href="/" className="hover:text-fg">
            Movies
          </Link>
          <Link href="/cinemas" className="hover:text-fg">
            Cinemas
          </Link>
          <Link href="/bookings" className="hover:text-fg">
            My bookings
          </Link>
        </nav>
      </div>
    </footer>
  );
}
