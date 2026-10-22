"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, fieldErrors } from "@/lib/ui/api";
import { Alert, Spinner } from "../ui";

export type MovieFormValues = {
  id?: string;
  title: string;
  synopsis: string;
  durationMinutes: number | "";
  language: string;
  ageRating: string;
  releaseDate: string;
  posterUrl: string | null;
  director: string | null;
  castList: string | null;
  isActive: boolean;
  genreSlugs: string[];
};

export function MovieForm({
  initial,
  genres,
}: {
  initial: MovieFormValues;
  genres: { name: string; slug: string }[];
}) {
  const router = useRouter();
  const editing = Boolean(initial.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "").trim();
    const optional = (k: string) => text(k) || null;
    const body = {
      title: text("title"),
      synopsis: text("synopsis"),
      durationMinutes: Number(text("durationMinutes")),
      language: text("language"),
      ageRating: text("ageRating"),
      releaseDate: text("releaseDate"),
      posterUrl: optional("posterUrl"),
      director: optional("director"),
      castList: optional("castList"),
      isActive: f.get("isActive") === "on",
      genreSlugs: f.getAll("genreSlugs").map(String),
    };
    setBusy(true);
    setError(null);
    setSuccess(null);
    setFields({});
    const res = editing
      ? await api<{ movie: { title: string } }>(`/api/admin/movies/${initial.id}`, { method: "PATCH", body })
      : await api<{ movie: { title: string } }>("/api/admin/movies", { method: "POST", body });
    setBusy(false);
    if (res.ok) {
      setSuccess(editing ? "Changes saved." : `“${res.data.movie.title}” was created.`);
      if (!editing) setFormKey((k) => k + 1);
      router.refresh();
      return;
    }
    const fe = fieldErrors(res.details);
    setFields(fe);
    setError(Object.keys(fe).length ? "Please fix the highlighted fields." : res.message);
  }

  const v = initial;
  return (
    <form key={formKey} onSubmit={onSubmit} noValidate className="card flex flex-col gap-4 p-5">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {success ? <Alert tone="success">{success}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="title" label="Title" defaultValue={v.title} error={fields.title} className="sm:col-span-2" />
        <div className="sm:col-span-2">
          <label htmlFor="m-synopsis" className="label">
            Synopsis
          </label>
          <textarea
            id="m-synopsis"
            name="synopsis"
            rows={4}
            defaultValue={v.synopsis}
            className={`input ${fields.synopsis ? "border-danger" : ""}`}
            aria-invalid={fields.synopsis ? true : undefined}
          />
          {fields.synopsis ? <p className="field-error">{fields.synopsis}</p> : null}
        </div>
        <Input name="durationMinutes" label="Duration (minutes)" type="number" defaultValue={String(v.durationMinutes)} error={fields.durationMinutes} />
        <Input name="releaseDate" label="Release date" type="date" defaultValue={v.releaseDate} error={fields.releaseDate} />
        <Input name="language" label="Language" defaultValue={v.language} error={fields.language} />
        <Input name="ageRating" label="Age rating" defaultValue={v.ageRating} error={fields.ageRating} />
        <Input name="director" label="Director" defaultValue={v.director ?? ""} error={fields.director} />
        <Input name="posterUrl" label="Poster URL (https, optional)" type="url" defaultValue={v.posterUrl ?? ""} error={fields.posterUrl} />
        <Input name="castList" label="Cast (comma separated)" defaultValue={v.castList ?? ""} error={fields.castList} className="sm:col-span-2" />
      </div>
      <fieldset>
        <legend className="label">Genres</legend>
        <div className="flex flex-wrap gap-2">
          {genres.map((g) => (
            <label key={g.slug} className="chip cursor-pointer has-[:checked]:border-accent has-[:checked]:bg-accent/15 has-[:checked]:text-accent">
              <input type="checkbox" name="genreSlugs" value={g.slug} defaultChecked={v.genreSlugs.includes(g.slug)} className="sr-only" />
              {g.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="isActive" defaultChecked={v.isActive} className="h-4 w-4 accent-[var(--color-accent)]" />
        Active (visible to customers)
      </label>
      <div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {editing ? (busy ? "Saving…" : "Save changes") : busy ? "Creating…" : "Create movie"}
        </button>
      </div>
    </form>
  );
}

function Input({
  name,
  label,
  type = "text",
  defaultValue,
  error,
  className = "",
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
  error?: string;
  className?: string;
}) {
  const id = `m-${name}`;
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        className={`input ${error ? "border-danger" : ""}`}
      />
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

export function MovieActiveToggle({ id, isActive }: { id: string; isActive: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    const res = await api(`/api/admin/movies/${id}`, { method: "PATCH", body: { isActive: !isActive } });
    setBusy(false);
    if (res.ok) router.refresh();
    else setError(res.message);
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={toggle} disabled={busy} className={isActive ? "btn-ghost min-h-8 px-2 py-1" : "btn-secondary min-h-8 px-2 py-1"}>
        {busy ? <Spinner /> : null}
        {isActive ? "Deactivate" : "Activate"}
      </button>
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
