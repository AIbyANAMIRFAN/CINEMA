import Link from "next/link";
import type { ReactNode } from "react";

const BADGE_STYLES: Record<string, string> = {
  CONFIRMED: "bg-success/15 text-success border-success/30",
  SUCCEEDED: "bg-success/15 text-success border-success/30",
  PENDING: "bg-accent/15 text-accent border-accent/30",
  SCHEDULED: "bg-info/15 text-info border-info/30",
  CANCELLED: "bg-surface-3 text-muted border-line-strong",
  EXPIRED: "bg-surface-3 text-muted border-line-strong",
  FAILED: "bg-danger/15 text-danger border-danger/30",
  REFUNDED: "bg-premium/15 text-premium border-premium/30",
  ADMIN: "bg-premium/15 text-premium border-premium/30",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const cls = BADGE_STYLES[status] ?? "bg-surface-3 text-muted border-line-strong";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide whitespace-nowrap ${cls}`}
    >
      {label ?? status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-2xl">
        🎬
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children ? <div className="max-w-md text-sm text-muted">{children}</div> : null}
      {action ? (
        <Link href={action.href} className="btn-secondary mt-2">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function Alert({ tone = "info", children }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  const cls = {
    info: "border-info/30 bg-info/10 text-info",
    error: "border-danger/30 bg-danger/10 text-danger",
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-accent/30 bg-accent/10 text-accent",
  }[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-xl border px-4 py-3 text-sm ${cls}`}>
      {children}
    </div>
  );
}

export function PageTitle({ title, eyebrow, children }: { title: string; eyebrow?: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2 sm:mb-8">
      {eyebrow ? <p className="text-xs font-semibold tracking-[0.2em] text-accent uppercase">{eyebrow}</p> : null}
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{title}</h1>
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
    />
  );
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card p-5">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-subtle">{hint}</p> : null}
    </div>
  );
}
