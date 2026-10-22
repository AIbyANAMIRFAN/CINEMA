import type { Metadata } from "next";
import { TicketVerifier } from "@/components/admin/ticket-verifier";
import { requireAdminPage } from "@/server/context";

export const metadata: Metadata = { title: "Verify ticket" };

export default async function AdminTicketsPage() {
  await requireAdminPage("/admin/tickets");
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Verify a ticket</h1>
        <p className="mt-1 text-sm text-muted">
          Paste the code from a scanned ticket QR (with or without the <span className="font-mono">CINEBOOK:</span> prefix).
        </p>
      </div>
      <TicketVerifier />
    </div>
  );
}
