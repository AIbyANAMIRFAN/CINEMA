import Link from "next/link";
import { EmptyState, StatCard, StatusBadge } from "@/components/ui";
import { formatMoney } from "@/lib/pricing";
import { adminRecentAudit, adminStats } from "@/server/admin";
import { db, requireAdminPage } from "@/server/context";

const STATUSES = ["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "REFUNDED"] as const;
const ADMIN_TZ = "UTC";

export default async function AdminDashboard() {
  await requireAdminPage("/admin");
  const [stats, audit] = await Promise.all([adminStats(db), adminRecentAudit(db, 25)]);
  const totalBookings = STATUSES.reduce((n, s) => n + (stats.bookingsByStatus[s] ?? 0), 0);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ADMIN_TZ, dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Revenue (30 days)" value={formatMoney(stats.revenue30dMinor)} hint="Confirmed bookings" />
        <StatCard label="Confirmed bookings" value={stats.confirmed30d} hint="Last 30 days" />
        <StatCard label="Upcoming showtimes" value={stats.upcomingShowtimes} hint="Scheduled" />
        <StatCard label="Registered users" value={stats.users} />
      </div>

      <section className="card p-5" aria-labelledby="by-status">
        <h2 id="by-status" className="mb-4 font-semibold">
          Bookings by status <span className="text-sm font-normal text-subtle">({totalBookings} total)</span>
        </h2>
        <ul className="flex flex-col gap-3">
          {STATUSES.map((s) => {
            const n = stats.bookingsByStatus[s] ?? 0;
            const pct = totalBookings ? Math.round((n / totalBookings) * 100) : 0;
            return (
              <li key={s} className="grid grid-cols-[110px_1fr_48px] items-center gap-3 text-sm">
                <Link href={`/admin/bookings?status=${s}`} className="hover:underline">
                  <StatusBadge status={s} />
                </Link>
                <div className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                  <div className="h-full rounded-full bg-accent/70" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-right tabular-nums">{n}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="audit">
        <h2 id="audit" className="mb-3 font-semibold">
          Recent activity <span className="text-sm font-normal text-subtle">(times in UTC)</span>
        </h2>
        {audit.length === 0 ? (
          <EmptyState title="No activity yet" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Action</th>
                  <th scope="col">Entity</th>
                  <th scope="col">Actor</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap text-muted">{fmt.format(a.createdAt)}</td>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td className="text-muted">
                      {a.entityType}
                      {a.entityId ? <span className="ml-1 font-mono text-xs text-subtle">{a.entityId.slice(0, 8)}</span> : null}
                    </td>
                    <td className="text-muted">{a.actorEmail ?? "system"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
