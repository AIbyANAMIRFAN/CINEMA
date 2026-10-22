"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, fieldErrors } from "@/lib/ui/api";
import { Alert, Spinner } from "./ui";

export function AuthForm({ mode, next }: { mode: "login" | "register"; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body =
      mode === "login"
        ? { email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") }
        : {
            name: String(form.get("name") ?? ""),
            email: String(form.get("email") ?? ""),
            password: String(form.get("password") ?? ""),
          };
    setBusy(true);
    setError(null);
    setFields({});
    const res = await api(`/api/auth/${mode}`, { body });
    if (res.ok) {
      router.replace(next);
      router.refresh();
      return;
    }
    setBusy(false);
    const fe = fieldErrors(res.details);
    setFields(fe);
    setError(Object.keys(fe).length ? "Please fix the highlighted fields." : res.message);
  }

  const q = next !== "/" ? `?next=${encodeURIComponent(next)}` : "";

  return (
    <form onSubmit={onSubmit} noValidate className="card flex flex-col gap-4 p-6 sm:p-8">
      {error ? <Alert tone="error">{error}</Alert> : null}
      {mode === "register" ? (
        <Field name="name" label="Full name" autoComplete="name" error={fields.name} />
      ) : null}
      <Field name="email" type="email" label="Email" autoComplete="email" error={fields.email} />
      <Field
        name="password"
        type="password"
        label="Password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        error={fields.password}
        hint={mode === "register" ? "At least 8 characters." : undefined}
      />
      <button type="submit" className="btn-primary mt-2" disabled={busy}>
        {busy ? <Spinner /> : null}
        {mode === "login" ? (busy ? "Signing in…" : "Sign in") : busy ? "Creating account…" : "Create account"}
      </button>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? (
          <>
            New to CineBook?{" "}
            <Link href={`/register${q}`} className="font-semibold text-accent hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link href={`/login${q}`} className="font-semibold text-accent hover:underline">
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

function Field({
  name,
  label,
  type = "text",
  autoComplete,
  error,
  hint,
}: {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  error?: string;
  hint?: string;
}) {
  const id = `f-${name}`;
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`input ${error ? "border-danger" : ""}`}
      />
      {error ? (
        <p id={`${id}-err`} className="field-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
