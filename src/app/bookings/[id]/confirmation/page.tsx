import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConfirmFlow } from "@/components/confirm-flow";
import { PageTitle } from "@/components/ui";
import { UUID_RE } from "@/lib/ids";
import { firstParam } from "@/lib/ui/format";
import { getBookingDetail } from "@/server/catalog";
import { db, requireUserPage } from "@/server/context";

export const metadata: Metadata = { title: "Booking confirmation" };

export default async function ConfirmationPage(props: PageProps<"/bookings/[id]/confirmation">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const sessionId = firstParam(sp.session_id)?.slice(0, 255) || null;
  const qs = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  const user = await requireUserPage(`/bookings/${id}/confirmation${qs}`);
  if (!UUID_RE.test(id)) notFound();
  const booking = await getBookingDetail(db, id, { userId: user.id });
  if (!booking) notFound();

  return (
    <div className="container-page max-w-2xl py-12">
      <PageTitle eyebrow="Payment" title={booking.movieTitle}>
        Booking {booking.reference}
      </PageTitle>
      <ConfirmFlow
        bookingId={booking.id}
        showtimeId={booking.showtimeId}
        sessionId={sessionId}
        initialStatus={booking.status}
      />
    </div>
  );
}
