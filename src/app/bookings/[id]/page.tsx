import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { CancelBookingButton, PrintButton } from "@/components/booking-actions";
import { BookingSummary } from "@/components/booking-summary";
import { Alert, StatusBadge } from "@/components/ui";
import { UUID_RE } from "@/lib/ids";
import { CANCELLATION_CUTOFF_MINUTES, formatMoney } from "@/lib/pricing";
import { formatDateTime, formatLongDate, formatTime, tzLabel } from "@/lib/ui/format";
import { getBookingDetail } from "@/server/catalog";
import { db, requireUserPage } from "@/server/context";

export const metadata: Metadata = { title: "Your ticket" };

export default async function BookingPage(props: PageProps<"/bookings/[id]">) {
  const { id } = await props.params;
  const user = await requireUserPage(`/bookings/${id}`);
  if (!UUID_RE.test(id)) notFound();
  const booking = await getBookingDetail(db, id, { userId: user.id, admin: user.role === "ADMIN" });
  if (!booking) notFound();

  const now = new Date();
  const ticketValid = booking.status === "CONFIRMED" && booking.ticket && !booking.ticket.revokedAt;
  const qrSvg = ticketValid
    ? await QRCode.toString(`CINEBOOK:${booking.ticket!.code}`, {
        type: "svg",
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#0b0b10", light: "#ffffff" },
      })
    : null;
  const holdLapsed = booking.status === "PENDING" && booking.holdExpiresAt <= now;
  const minutesToShow = (booking.startsAt.getTime() - now.getTime()) / 60_000;
  const canCancel =
    (booking.status === "PENDING" && !holdLapsed) ||
    (booking.status === "CONFIRMED" && minutesToShow > CANCELLATION_CUTOFF_MINUTES);
  const isOwner = booking.userId === user.id;

  return (
    <div className="container-page py-10">
      <div className="no-print mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/bookings" className="text-sm text-muted hover:text-fg">
          ← My bookings
        </Link>
        {ticketValid ? <PrintButton /> : null}
      </div>

      {!isOwner ? (
        <div className="mb-4">
          <Alert tone="info">You are viewing another customer&apos;s booking as an administrator.</Alert>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
        <article className="card print-plain overflow-hidden" aria-labelledby="ticket-title">
          <div className="flex flex-col gap-1 border-b border-dashed border-line-strong bg-gradient-to-br from-accent/15 to-transparent p-6">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold tracking-[0.25em] text-accent uppercase">CineBook ticket</p>
              <StatusBadge status={holdLapsed ? "EXPIRED" : booking.status} />
            </div>
            <h1 id="ticket-title" className="text-2xl font-black tracking-tight sm:text-3xl">
              {booking.movieTitle}
            </h1>
            <p className="text-sm text-muted">{booking.ageRating}</p>
          </div>

          <div className="grid gap-6 p-6 sm:grid-cols-[1fr_auto]">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <Item label="Date" value={formatLongDate(booking.startsAt, booking.timezone)} />
              <Item
                label="Time"
                value={`${formatTime(booking.startsAt, booking.timezone)} ${tzLabel(booking.startsAt, booking.timezone)}`}
              />
              <Item label="Cinema" value={booking.cinemaName} />
              <Item label="Screen" value={booking.auditoriumName} />
              <Item label="Seats" value={booking.seats.map((s) => `${s.row}${s.number}`).join(", ")} />
              <Item label="Reference" value={booking.reference} mono />
              <div className="col-span-2">
                <dt className="label">Address</dt>
                <dd>{booking.cinemaAddress}</dd>
              </div>
            </dl>

            {qrSvg ? (
              <div className="flex flex-col items-center gap-2">
                <div
                  className="h-44 w-44 rounded-xl bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
                  role="img"
                  aria-label={`Ticket QR code for booking ${booking.reference}`}
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
                <p className="text-center text-xs text-subtle">Show this code at the entrance</p>
              </div>
            ) : (
              <div className="flex h-44 w-44 items-center justify-center rounded-xl border border-dashed border-line-strong p-4 text-center text-xs text-subtle">
                {booking.status === "PENDING" && !holdLapsed
                  ? "Your ticket QR code appears once payment is complete."
                  : booking.ticket?.revokedAt
                    ? "This ticket has been revoked."
                    : "No valid ticket for this booking."}
              </div>
            )}
          </div>
        </article>

        <div className="flex flex-col gap-4">
          {booking.status === "PENDING" && !holdLapsed && isOwner ? (
            <div className="card flex flex-col gap-3 p-5">
              <Alert tone="warning">This booking is awaiting payment.</Alert>
              <Link href={`/checkout/${booking.id}`} className="btn-primary">
                Continue to payment
              </Link>
            </div>
          ) : null}
          <BookingSummary booking={booking} />
          {canCancel ? (
            <div className="card no-print flex flex-col gap-2 p-5">
              <h2 className="font-semibold">Need to cancel?</h2>
              <p className="text-sm text-muted">
                {booking.status === "CONFIRMED"
                  ? `Confirmed bookings can be cancelled for a full refund up to ${CANCELLATION_CUTOFF_MINUTES / 60} hours before the show.`
                  : "Cancelling releases your held seats immediately."}
              </p>
              <CancelBookingButton
                bookingId={booking.id}
                confirmed={booking.status === "CONFIRMED"}
                currency={booking.currency}
                totalMinor={booking.totalMinor}
              />
            </div>
          ) : booking.status === "CONFIRMED" && minutesToShow > 0 ? (
            <p className="text-xs text-subtle">
              Online cancellation closes {CANCELLATION_CUTOFF_MINUTES / 60} hours before the show.
            </p>
          ) : null}
        </div>
      </div>

      <section className="mt-10" aria-labelledby="payments-title">
        <h2 id="payments-title" className="mb-3 text-lg font-semibold">
          Payment history
        </h2>
        {booking.payments.length === 0 ? (
          <p className="text-sm text-muted">No payment attempts yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {booking.payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {formatDateTime(p.createdAt, booking.timezone)} {tzLabel(p.createdAt, booking.timezone)}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="tabular-nums">{formatMoney(p.amountMinor, p.currency)}</td>
                    <td className="text-muted">{p.failureReason ? p.failureReason.replace(/_/g, " ") : "—"}</td>
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

function Item({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className={`font-semibold ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
