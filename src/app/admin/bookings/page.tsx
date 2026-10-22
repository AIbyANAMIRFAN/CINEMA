import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/pricing";
import { firstParam, formatDateTime, tzLabel } from "@/lib/ui/format";
import { adminListBookings } from "@/server/admin";
import { db, requireAdminPage } from "@/server/context";

export const metadata: Metadata = { title: "Bookings" };

const STATUSES = ["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "REFUNDED"] as const;

export default async function AdminBookingsPage(props: PageProps<"/admin/bookings">) {
  const sp = await props.searchParams;
  const raw = firstParam(sp.status);
  const status = STATUSES.find((s) => s === raw);
  await requireAdminPage(`/admin/bookings${status ? `?status=${status}` : ""}`);
  const bookings = await adminListBookings(db, { status, limit: 200 });
  const created = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight">Bookings</h1>
      <nav aria-label="Filter by status" className="-mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
        <Link href="/admin/bookings" className={`chip shrink-0 ${!status ? "chip-active" : ""}`}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/admin/bookings?status=${s}`} className={`chip shrink-0 ${status === s ? "chip-active" : ""}`}>
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </Link>
        ))}
      </nav>
      {bookings.length === 0 ? (
        <EmptyState title="No bookings found">{status ? "Nothing with this status yet." : "No bookings have been made yet."}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Reference</th>
                <th scope="col">Customer</th>
                <th scope="col">Movie · show (local)</th>
                <th scope="col">Total</th>
                <th scope="col">Status</th>
                <th scope="col">Created (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/bookings/${b.id}`} className="font-mono text-xs font-semibold text-accent hover:underline">
                      {b.reference}
                    </Link>
                  </td>
                  <td className="text-muted">{b.userEmail}</td>
                  <td>
                    <p className="font-medium">{b.movieTitle}</p>
                    <p className="text-xs text-subtle">
                      {formatDateTime(b.startsAt, b.timezone)} {tzLabel(b.startsAt, b.timezone)} · {b.cinemaName}
                    </p>
                  </td>
                  <td className="tabular-nums">{formatMoney(b.totalMinor, b.currency)}</td>
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="whitespace-nowrap text-muted">{created.format(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
