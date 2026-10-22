import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin · CineBook" } };

const LINKS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/movies", label: "Movies" },
  { href: "/admin/showtimes", label: "Showtimes" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/tickets", label: "Verify ticket" },
] as const;

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="container-page py-8">
      <div className="mb-8 flex flex-col gap-4 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs font-semibold tracking-[0.25em] text-premium uppercase">Admin console</p>
        <nav aria-label="Admin" className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="btn-ghost shrink-0">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
