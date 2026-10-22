"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/ui/api";

export function LogoutButton({ className = "btn-ghost" }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setBusy(true);
    setError(null);
    const res = await api("/api/auth/logout", { method: "POST", body: {} });
    if (!res.ok) {
      setBusy(false);
      setError(res.message);
      return;
    }
    const protectedPath = /^\/(bookings|checkout|admin)(\/|$)/.test(window.location.pathname);
    if (protectedPath) router.replace("/");
    router.refresh();
    setBusy(false);
  }

  return (
    <>
      <button type="button" onClick={logout} disabled={busy} className={className} title={error ?? undefined}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
      {error ? (
        <span role="alert" className="sr-only">
          {error}
        </span>
      ) : null}
    </>
  );
}
