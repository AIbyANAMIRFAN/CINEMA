export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="container-page py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="skeleton mb-3 h-4 w-28" />
      <div className="skeleton mb-8 h-9 w-2/3 max-w-md" />
      <div className="flex flex-col gap-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton h-24" />
        ))}
      </div>
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="container-page grid gap-8 py-10 sm:grid-cols-[220px_1fr] lg:grid-cols-[280px_1fr]" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="skeleton mx-auto aspect-[2/3] w-48 sm:w-full" />
      <div className="flex flex-col gap-4">
        <div className="skeleton h-6 w-40" />
        <div className="skeleton h-12 w-3/4" />
        <div className="skeleton h-4 w-1/2" />
        <div className="skeleton h-24 w-full max-w-2xl" />
        <div className="skeleton h-10 w-32" />
      </div>
    </div>
  );
}

export function SeatMapSkeleton() {
  return (
    <div className="container-page grid gap-6 py-8 lg:grid-cols-[1fr_340px]" aria-busy="true">
      <span className="sr-only">Loading seat map…</span>
      <div className="flex flex-col gap-4">
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-[420px]" />
      </div>
      <div className="skeleton h-72" />
    </div>
  );
}
