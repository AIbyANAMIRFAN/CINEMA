export default function Loading() {
  return (
    <div className="container-page flex justify-center py-12 sm:py-20" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex w-full max-w-md flex-col gap-4">
        <div className="skeleton mx-auto h-9 w-56" />
        <div className="skeleton mx-auto h-4 w-72" />
        <div className="skeleton h-72" />
      </div>
    </div>
  );
}
