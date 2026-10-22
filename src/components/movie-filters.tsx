"use client";

import Form from "next/form";
import { useRef } from "react";

type Option = { value: string; label: string };

/** GET filter form for the movie grid. Selects submit on change; the text search submits on Enter or the button. */
export function MovieFilters({
  values,
  genres,
  languages,
  cinemas,
}: {
  values: { q?: string; genre?: string; language?: string; cinema?: string; date?: string };
  genres: Option[];
  languages: Option[];
  cinemas: Option[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submit = () => formRef.current?.requestSubmit();

  return (
    <Form ref={formRef} action="/" scroll={false} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end">
      <div>
        <label htmlFor="f-q" className="label">
          Search
        </label>
        <input
          id="f-q"
          name="q"
          type="search"
          defaultValue={values.q ?? ""}
          placeholder="Search by title…"
          className="input"
          maxLength={100}
        />
      </div>
      <Select id="f-genre" name="genre" label="Genre" value={values.genre} options={genres} all="All genres" onChange={submit} />
      <Select
        id="f-language"
        name="language"
        label="Language"
        value={values.language}
        options={languages}
        all="All languages"
        onChange={submit}
      />
      <Select id="f-cinema" name="cinema" label="Cinema" value={values.cinema} options={cinemas} all="All cinemas" onChange={submit} />
      {values.date ? <input type="hidden" name="date" value={values.date} /> : null}
      <button type="submit" className="btn-primary">
        Search
      </button>
    </Form>
  );
}

function Select({
  id,
  name,
  label,
  value,
  options,
  all,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  value?: string;
  options: Option[];
  all: string;
  onChange: () => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value ?? ""} onChange={onChange} className="input">
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
