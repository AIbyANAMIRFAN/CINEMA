"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { formatMoney } from "@/lib/pricing";
import { api, fieldErrors } from "@/lib/ui/api";
import { formatDateTime, parseMoneyToMinor, tzLabel, zonedLocalToUtc } from "@/lib/ui/format";
import { Alert, Spinner } from "../ui";

type MovieOpt = { id: string; title: string; isActive: boolean };
type AudOpt = { id: string; name: string; cinemaName: string; timezone: string; seats: number };

export function ShowtimeForm({ movies, auditoriums }: { movies: MovieOpt[]; auditoriums: AudOpt[] }) {
  const router = useRouter();
  const [audId, setAudId] = useState(auditoriums[0]?.id ?? "");
  const [local, setLocal] = useState("");
  const [price, setPrice] = useState("12.00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const aud = auditoriums.find((a) => a.id === audId);
  const utc = aud && local ? zonedLocalToUtc(local, aud.timezone) : null;
  const priceMinor = parseMoneyToMinor(price);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const fe: Record<string, string> = {};
    if (!aud) fe.auditoriumId = "Choose a screen.";
    if (!utc) fe.startsAt = "Enter a valid start date and time.";
    if (priceMinor === null) fe.basePriceMinor = "Enter a price like 12.50.";
    if (Object.keys(fe).length) {
      setFields(fe);
      setError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    setFields({});
    const res = await api("/api/admin/showtimes", {
      body: {
        movieId: String(f.get("movieId") ?? ""),
        auditoriumId: audId,
        startsAt: utc!.toISOString(),
        basePriceMinor: priceMinor,
        turnaroundMinutes: Number(f.get("turnaroundMinutes") ?? 15),
      },
    });
    setBusy(false);
    if (res.ok) {
      setSuccess(`Showtime created for ${formatDateTime(utc!, aud!.timezone)} ${tzLabel(utc!, aud!.timezone)}.`);
      setLocal("");
      router.refresh();
      return;
    }
    const zf = fieldErrors(res.details);
    setFields(zf);
    setError(res.message);
  }

  if (!movies.length || !auditoriums.length) {
    return <Alert tone="info">You need at least one movie and one screen before you can schedule showtimes.</Alert>;
  }

  return (
    <form onSubmit={onSubmit} noValidate className="card flex flex-col gap-4 p-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="s-movie" className="label">
            Movie
          </label>
          <select id="s-movie" name="movieId" className="input" defaultValue={movies.find((m) => m.isActive)?.id}>
            {movies.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
                {m.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </select>
          {fields.movieId ? <p className="field-error">{fields.movieId}</p> : null}
        </div>
        <div>
          <label htmlFor="s-aud" className="label">
            Cinema · screen
          </label>
          <select id="s-aud" className="input" value={audId} onChange={(e) => setAudId(e.target.value)}>
            {auditoriums.map((a) => (
              <option key={a.id} value={a.id}>
                {a.cinemaName} · {a.name} ({a.seats} seats)
              </option>
            ))}
          </select>
          {fields.auditoriumId ? <p className="field-error">{fields.auditoriumId}</p> : null}
        </div>
        <div>
          <label htmlFor="s-start" className="label">
            Starts (local time{aud ? `, ${aud.timezone.replace(/_/g, " ")}` : ""})
          </label>
          <input
            id="s-start"
            type="datetime-local"
            className={`input ${fields.startsAt ? "border-danger" : ""}`}
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            required
          />
          {fields.startsAt ? (
            <p className="field-error">{fields.startsAt}</p>
          ) : utc ? (
            <p className="mt-1 text-xs text-subtle">= {utc.toISOString().replace("T", " ").slice(0, 16)} UTC</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="s-price" className="label">
            Base price (USD)
          </label>
          <input
            id="s-price"
            inputMode="decimal"
            className={`input ${fields.basePriceMinor ? "border-danger" : ""}`}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          {fields.basePriceMinor ? (
            <p className="field-error">{fields.basePriceMinor}</p>
          ) : priceMinor !== null ? (
            <p className="mt-1 text-xs text-subtle">
              Standard {formatMoney(priceMinor)} · premium seats are priced higher automatically
            </p>
          ) : null}
        </div>
        <div>
          <label htmlFor="s-turn" className="label">
            Cleaning turnaround (minutes)
          </label>
          <input id="s-turn" name="turnaroundMinutes" type="number" min={0} max={120} defaultValue={15} className="input" />
        </div>
      </div>
      <div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {busy ? "Scheduling…" : "Create showtime"}
        </button>
      </div>
    </form>
  );
}

export function CancelShowtimeButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "error" | "success"; text: string } | null>(null);

  async function cancel() {
    if (!window.confirm(`Cancel ${label}? Confirmed bookings will be refunded and held seats released.`)) return;
    setBusy(true);
    setMsg(null);
    const res = await api<{ refunded: number; released: number; failures: string[] }>(`/api/admin/showtimes/${id}`, {
      method: "PATCH",
      body: { status: "CANCELLED" },
    });
    setBusy(false);
    if (res.ok) {
      const { refunded, released, failures } = res.data;
      setMsg({
        tone: failures.length ? "error" : "success",
        text: `Cancelled. ${refunded} refunded, ${released} released${failures.length ? `, ${failures.length} failed — retry from bookings` : ""}.`,
      });
      router.refresh();
      return;
    }
    setMsg({
      tone: "error",
      text: res.status >= 500 ? "Couldn't cancel: the payment provider may be unavailable." : res.message,
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" onClick={cancel} disabled={busy} className="btn-danger min-h-8 px-2 py-1">
        {busy ? <Spinner /> : null}
        Cancel
      </button>
      {msg ? (
        <span role={msg.tone === "error" ? "alert" : "status"} className={`max-w-[16rem] text-right text-xs ${msg.tone === "error" ? "text-danger" : "text-success"}`}>
          {msg.text}
        </span>
      ) : null}
    </span>
  );
}
