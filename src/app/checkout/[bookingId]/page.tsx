import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookingSummary } from "@/components/booking-summary";
import { CheckoutPanel } from "@/components/checkout-panel";
import { Alert, PageTitle, StatusBadge } from "@/components/ui";
import { UUID_RE } from "@/lib/ids";
import { formatMoney } from "@/lib/pricing";
import { formatTime, tzLabel } from "@/lib/ui/format";
import { getBookingDetail } from "@/server/catalog";
import { db, requireUserPage } from "@/server/context";

export const metadata: Metadata = { title: "Checkout" };

export default async function CheckoutPage(props: PageProps<"/checkout/[bookingId]">) {
  const { bookingId } = await props.params;
  const sp = await props.searchParams;
  const user = await requireUserPage(`/checkout/${bookingId}`);
  if (!UUID_RE.test(bookingId)) notFound();
  const booking = await getBookingDetail(db, bookingId, { userId: user.id });
  if (!booking) notFound();

  const now = new Date();
  const holdLapsed = booking.status === "PENDING" && booking.holdExpiresAt <= now;
  const payable = booking.status === "PENDING" && !holdLapsed;
  const holdUntil = `${formatTime(booking.holdExpiresAt, booking.timezone)} ${tzLabel(booking.holdExpiresAt, booking.timezone)}`;
  const lastFailed = booking.payments.find((p) => p.status === "FAILED");

  return (
    <div className="container-page py-10">
      <PageTitle eyebrow="Checkout" title={payable ? "Review and pay" : "Booking status"}>
        <span className="inline-flex items-center gap-2">
          Booking {booking.reference} <StatusBadge status={holdLapsed ? "EXPIRED" : booking.status} />
        </span>
      </PageTitle>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <BookingSummary booking={booking} />

        <div className="flex flex-col gap-4">
          {payable ? (
            <>
              {sp.cancelled === "1" ? (
                <Alert tone="warning">
                  Payment was cancelled. Your seats are still held until {holdUntil}; you can retry below.
                </Alert>
              ) : lastFailed?.failureReason && lastFailed.failureReason !== "provider_error" ? (
                <Alert tone="error">Your last payment attempt didn&apos;t go through. You can try again.</Alert>
              ) : null}
              <CheckoutPanel
                bookingId={booking.id}
                showtimeId={booking.showtimeId}
                holdExpiresAt={booking.holdExpiresAt.toISOString()}
                serverNow={now.getTime()}
                totalLabel={formatMoney(booking.totalMinor, booking.currency)}
                holdUntil={holdUntil}
              />
            </>
          ) : booking.status === "CONFIRMED" ? (
            <div className="card flex flex-col gap-3 p-5">
              <Alert tone="success">Payment received — your booking is confirmed.</Alert>
              <Link href={`/bookings/${booking.id}`} className="btn-primary">
                View your ticket
              </Link>
            </div>
          ) : (
            <div className="card flex flex-col gap-3 p-5">
              <Alert tone={booking.status === "REFUNDED" ? "info" : "warning"}>
                {holdLapsed || booking.status === "EXPIRED"
                  ? "Your seat hold expired before payment was completed, so the seats were released."
                  : booking.status === "CANCELLED"
                    ? "This booking was cancelled and its seats were released."
                    : "This booking was refunded."}
              </Alert>
              <Link href={`/showtimes/${booking.showtimeId}`} className="btn-primary">
                Choose seats again
              </Link>
              <Link href="/bookings" className="btn-secondary">
                My bookings
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
